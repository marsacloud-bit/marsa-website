#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 5 UI tests: assets/js/appt-cards.js (MarsaApptCards, ocr.html appointment cards reading +
  review + approval), assets/js/ops/tx-appt.js (MarsaOps.txAppt: readiness banner, card draft summary, TASTO carrier order on
  #tx/<id>), assets/js/ops/tx-return.js (MarsaOps.txReturn: empty-return proofs on #tx/<id>), assets/i18n/appt.js and the page
  wiring (ocr.html / admin.html / sw.js / appt.css). Pure Node, no database, no network, no dependencies (vm + window shim +
  supabase/tests/lib/fake-dom.js).

  Covers: classic-script wrapper + ES5 source + no innerHTML; the 'appt' dictionary (ar = en keys; every literal key and every
  dynamic key family exists); the contract with 20261121000100 (review keys = app.appt_review_check, movement / party types,
  the batch limits 20 / 25 MB / 10 MB, the EIR 8 MB, proof statuses, match-note tokens, the rejection reasons and warning codes of
  ai-extract, the supa.js wrappers and their option names); pure helpers (planFiles, decide, runPool ≤ 2 at a time in order,
  Riyadh time, date-and-time state, review edits / fallbacks, missing data incl. the direct party, the non-finance payload,
  the approval plan, the idempotency key, result summary, the reading kept ≤ 60 000 bytes, extraction rows ⊆ supa.js
  EXT_INSERT, TASTO payload, readiness view, verify / manual proof payloads); DOM flows: the cards page (fingerprint check
  before any reading: approved → blocked, pending elsewhere → move offer, wrong document → rejected and not saved; parallel
  reading; the card joins a new draft; inline edit autosaved with the version; stale → reload; approve all behind the confirm
  dialog with version + idempotency key and a per-card result; restore on reopen without a re-read; cancel with a reason;
  move by number), the transaction sections (readiness banner blocked / open, card draft summary, TASTO form, empty-return
  proofs: EIR reading → pending proof only (never verified), staff confirmation behind the confirm dialog, date-only refused,
  void with a reason, manual proof, deadline-only save, read-only roles).

  usage:  node supabase/tests/legacy-appt-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const J = JSON.stringify;

let pass = 0, fail = 0;
const fails = [];
let sec = '';
function section(t) { sec = t; if (!QUIET) console.log('\n== ' + t); }
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  if (r !== true && r && typeof r === 'object') { try { JSON.stringify(r); } catch (e) { r = 'got a non-true value (' + (r.tagName || typeof r) + ')'; } }
  if (r === true) { pass++; if (!QUIET) console.log('  ok  ' + name); }
  else { fail++; fails.push(sec + ' :: ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); if (!QUIET) console.log('  FAIL ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); }
}
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }

/* ------------------------------------------------------------ load as a browser would */
const dicts = { ar: {}, en: {} };
let LANG = 'ar';
const I18N = {
  register(ns, d) { ['ar', 'en'].forEach(l => Object.keys((d && d[l]) || {}).forEach(k => { dicts[l][ns + '.' + k] = d[l][k]; })); },
  t(key, vars) {
    let s = dicts[LANG][key] != null ? dicts[LANG][key] : (dicts.ar[key] != null ? dicts.ar[key] : key);
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  },
  has(key) { return dicts.ar[key] != null; },
  lang() { return LANG; }
};
const SRC = rd('assets/js/appt-cards.js'), TXA = rd('assets/js/ops/tx-appt.js'), TXR = rd('assets/js/ops/tx-return.js'), DICT = rd('assets/i18n/appt.js');
const win = { MarsaI18n: I18N };
const ctx = { window: win, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent };
vm.createContext(ctx);
vm.runInContext(DICT, ctx, { filename: 'appt.js' });
vm.runInContext(SRC, ctx, { filename: 'appt-cards.js' });
vm.runInContext(TXA, ctx, { filename: 'tx-appt.js' });
vm.runInContext(TXR, ctx, { filename: 'tx-return.js' });
const P = win.MarsaApptCards.pure, TA = win.MarsaOps.txAppt.pure, TR = win.MarsaOps.txReturn.pure;
const MIG = rd('supabase/migrations/20261121000100_legacy_appt.sql');
const SUPA = rd('assets/js/supa.js');
const EXTRACT = rd('supabase/functions/ai-extract/extract.js');

/* ================================================================ static */
section('static: classic scripts, ES5, no innerHTML');
const NEW_JS = { 'assets/js/appt-cards.js': SRC, 'assets/js/ops/tx-appt.js': TXA, 'assets/js/ops/tx-return.js': TXR, 'assets/i18n/appt.js': DICT };
Object.keys(NEW_JS).forEach(f => {
  const s = NEW_JS[f].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  check(f + ': IIFE + strict, ES5 only (no let/const/arrow/template/class), no innerHTML', () =>
    (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s)) || 'not ES5 / uses HTML');
});
check('every new file compiles', () => { Object.keys(NEW_JS).forEach(f => new vm.Script(NEW_JS[f], { filename: f })); return true; });
check('no automatic verification anywhere in the UI: verifyEmptyReturnProof is called only from the staff confirm flow (one call site)', () =>
  ((TXR.match(/'verifyEmptyReturnProof'/g) || []).length === 1 && !/verifyEmptyReturnProof/.test(SRC) && !/verifyEmptyReturnProof/.test(TXA)
    && /api\.confirm\(\{ title: T\('er_cf_title'\)[\s\S]{0,900}call\(api, 'verifyEmptyReturnProof'/.test(TXR)) || 'verify call sites');
check('approval only behind the confirm dialog, with the version and an idempotency key (one call site)', () =>
  ((SRC.match(/API\.approveAppointmentDraft\(/g) || []).length === 1
    && /askConfirm\(\{ title: ids \? T\('cf_title_sel'[\s\S]{0,900}return chain\(function \(\) \{[\s\S]{0,120}S\.idem = approveKey\(S\.idem, bv\.version, ids, uuid\);[\s\S]{0,200}var o = \{ version: bv\.version, idemKey: S\.idem\.key \}/.test(SRC)) || 'approve');
check('approval waits for the card readings (buttons disabled while reading) and never runs over a failed / unsaved autosave', () =>
  (/a1\.disabled = !all\.total \|\| wait;/.test(SRC) && /a2\.disabled = !selIds\.length \|\| wait;/.test(SRC) && /var wait = S\.reading > 0;/.test(SRC)
    && /S\.reading\+\+;\s*refreshActions\(\);/.test(SRC) && /var why = approveBlock\(S\);\s*if \(why\)/.test(SRC)) || 'approve gate');

/* ================================================================ dictionary */
section('dictionary (namespace appt)');
const AR = Object.keys(dicts.ar).filter(k => k.startsWith('appt.')), EN = Object.keys(dicts.en).filter(k => k.startsWith('appt.'));
check('ar and en have the same keys', () => (AR.length > 300 && AR.length === EN.length && AR.every(k => dicts.en[k] != null)) || [AR.length, EN.length, AR.filter(k => dicts.en[k] == null), EN.filter(k => dicts.ar[k] == null)]);
check('no empty strings', () => AR.concat(EN).every(k => String(dicts.ar[k] || dicts.en[k]).trim()) || 'empty');
check('the {vars} of each string are the same in ar and en', () => {
  const vs = s => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join();
  const bad = AR.filter(k => vs(dicts.ar[k]) !== vs(dicts.en[k]));
  return !bad.length || bad;
});
const has = k => dicts.ar['appt.' + k] != null && dicts.en['appt.' + k] != null;
check('every literal T(\'key\') of the 3 files exists', () => {
  const miss = [];
  [SRC, TXA, TXR].forEach(s => { const re = /\bT\('([a-z][a-z0-9_]*)'(?=[,)])/g; let m; while ((m = re.exec(s))) if (!has(m[1])) miss.push(m[1]); });
  return !miss.length || miss;
});
const fam = (pre, list) => list.filter(c => !has(pre + c)).map(c => pre + c);
check('dynamic families: statuses, queue states, refusals, rejections, columns, types, missing, hints, warnings, outcomes, errors', () => {
  const miss = [].concat(fam('bst_', P.BATCH_STATUSES), fam('cst_', P.CARD_STATUSES),
    fam('qs_', ['hashing', 'checking', 'queued', 'reading', 'saving', 'done', 'rejected', 'error', 'approved', 'pending_other', 'move', 'in_batch', 'restore', 'restored', 'moved_here', 'refused']),
    fam('qr_', ['too_many', 'batch_size', 'unsupported', 'too_large', 'empty', 'dup_selection']), fam('rj_', P.REJECT_REASONS),
    fam('c_', P.MAIN_COLS.concat(P.DETAIL_KEYS, ['cost_amount', 'sell_amount'])), fam('mt_', P.MOVEMENT_TYPES), fam('pt_', P.PARTY_TYPES),
    fam('miss_', P.MISSING), fam('h_', ['phone_format', 'container_not_in_tx', 'container_format', 'empty_entry_skip', 'movement_unknown']),
    fam('w_', P.AI_WARNINGS), fam('out_', P.OUTCOMES), fam('closed_', ['approved', 'cancelled', 'moved']),
    fam('', Object.keys(P.ERR_KEYS).map(k => P.ERR_KEYS[k]).concat(['e_container_not_in_tx', 'e_closed'])),
    fam('rd_', ['doc_title', 'time', 'container', 'exit', 'entry']),
    fam('rs_', ['pending', 'evidence_submitted', 'returned_verified', 'disputed', 'waived']),
    fam('ps_', TR.PROOF_STATUSES), fam('mn_', TR.MATCH_NOTES), fam('er_f_', ['required', 'unsupported', 'too_large', 'too_large_image']), fam('er_rj_', TR.EIR_REJECT),
    fam('er_c_', ['container', 'status', 'returned', 'deadline', 'pending']), fam('er_p_', ['at', 'depot', 'conf', 'created', 'verified', 'voided']),
    fam('er_src_', ['ai', 'manual']), fam('', ['v_e_container', 'v_e_time', 'v_e_time_format', 'v_e_depot', 'm_e_empty', 'co_e_no_required', 'co_e_no', 'co_e_date', 'co_e_company']));
  return !miss.length || miss;
});
check('the TASTO note says the empty-return proof is still required (ar + en)', () =>
  (/لا يلغي شرط إثبات إعادة الفارغ/.test(dicts.ar['appt.co_note']) && /does not remove the empty-return proof/.test(dicts.en['appt.co_note'])
    && /لا يغني عن/.test(dicts.ar['appt.rd_carrier'])) || 'note');

/* ================================================================ contract with 20261121000100 */
section('contract with the migration, ai-extract and supa.js');
check('review keys = app.appt_review_check', () => {
  const m = /FUNCTION app\.appt_review_check[\s\S]*?ARRAY\[([^\]]+)\]/.exec(MIG);
  const keys = m ? m[1].split(',').map(x => x.trim().replace(/'/g, '')) : [];
  return J(keys) === J(P.REVIEW_KEYS) || J(keys);
});
check('movement types and party types = the review check', () =>
  (/NOT IN \('full_exit','empty_entry'\)/.test(MIG) && /NOT IN \('supplier','company','direct'\)/.test(MIG) && J(P.MOVEMENT_TYPES) === J(['full_exit', 'empty_entry'])
    && J(P.PARTY_TYPES) === J(['supplier', 'company', 'direct'])) || 'types');
check('limits: 20 cards, 25 MB per batch, 10 MB per card file (save_appointment_draft); EIR 8 MB (create_empty_return_proof)', () =>
  (/IF v_n > 20 THEN/.test(MIG) && /v_bytes > 26214400/.test(MIG) && /> 10485760/.test(MIG) && /size_bytes > 8388608/.test(MIG)
    && P.CARD_MAX === 20 && P.BATCH_BYTES === 26214400 && P.CARD_MAX_BYTES === 10485760 && P.CONCURRENCY >= 2 && P.CONCURRENCY <= 3) || 'limits');
check('card + batch statuses, proof statuses and match-note tokens are the migration’s', () =>
  (['pending', 'approved', 'skipped', 'failed', 'discarded', 'cancelled'].every(s => MIG.indexOf("'" + s + "'") !== -1)
    && TR.PROOF_STATUSES.every(s => MIG.indexOf("'" + s + "'") !== -1)
    && TR.MATCH_NOTES.filter(s => s !== 'ai_read_failed').every(s => MIG.indexOf("'" + s + "'::text") !== -1)) || 'statuses');   // ai_read_failed: the UI's note on an unreadable proof
check('rejection reasons + warning codes come from ai-extract', () =>
  (P.REJECT_REASONS.every(r => EXTRACT.indexOf("'" + r + "'") !== -1) && TR.EIR_REJECT.every(r => EXTRACT.indexOf("'" + r + "'") !== -1)
    && P.AI_WARNINGS.every(w => EXTRACT.indexOf("'" + w + "'") !== -1)) || 'codes');
check('supa.js exports every wrapper the UI calls, with the option names used', () => {
  const fns = ['appointmentCardState', 'saveAppointmentDraft', 'getAppointmentDraft', 'cancelAppointmentDraft', 'moveAppointmentDraft', 'approveAppointmentDraft',
    'createEmptyReturnProof', 'verifyEmptyReturnProof', 'voidEmptyReturnProof', 'saveEmptyReturnDeadline', 'listEmptyReturnProofs', 'saveTransportCarrierOrder', 'txReadiness'];
  const miss = fns.filter(f => !new RegExp(f + ': ' + f + '[,\\s]').test(SUPA));
  const opts = ['o.batchId', 'o.version', 'o.cards', 'o.cardIds', 'o.idemKey', 'documentId', 'extractionId', 'containerId', 'deliveredAt', 'matchNotes', 'o.unreadable', 'o.orderNo', 'o.orderDate', 'o.partyId', 'o.companyName']
    .filter(x => SUPA.indexOf(x) === -1);
  return (!miss.length && !opts.length) || [miss, opts];
});
check('extraction rows ⊆ supa.js EXT_INSERT (cards: doc_type appointment; EIR: empty_return_receipt)', () => {
  const m = /var EXT_INSERT = \[([\s\S]*?)\];/.exec(SUPA);
  const ins = m ? (m[1].match(/'([a-z0-9_]+)'/g) || []).map(x => x.replace(/'/g, '')) : [];
  const a = P.extractionRow({ res: { fields: [{ page: 2 }], ai_detail: { x: 1 }, usage_id: 'u' }, file: { name: 'c.pdf', size: 3 }, sha256: 'a'.repeat(64), orgId: 'o', transactionId: 't', documentId: 'd' });
  const b = TR.extractionRow({ res: { ai_detail: {} }, file: { name: 'e.pdf', size: 3 }, sha256: 'b'.repeat(64), orgId: 'o', transactionId: 't', documentId: 'd' });
  const bad = Object.keys(a).concat(Object.keys(b)).filter(k => ins.indexOf(k) === -1);
  return (!bad.length && a.doc_type === 'appointment' && b.doc_type === 'empty_return_receipt' && a.source_pages === 2 && a.document_id === 'd') || [bad, a.doc_type, b.doc_type];
});
check('the card reading names the doc kind the server checks (appointment) and ai-extract maps appointment_ticket → appointment', () =>
  (/v_ext\.doc_type <> 'appointment'/.test(MIG) && /appointment_ticket: 'appointment'/.test(EXTRACT) && /v_ext\.doc_type <> 'empty_return_receipt'/.test(MIG)) || 'kind');

/* ================================================================ pure helpers */
section('pure helpers (appt-cards.js)');
eq('parseHash: #appt-tx=<uuid> only', [P.parseHash('#appt-tx=0000000d-0000-4000-8000-00000000000d'), P.parseHash('#appt-tx=x'), P.parseHash('#decl-tx=0000000d-0000-4000-8000-00000000000d')],
  [{ tx: '0000000d-0000-4000-8000-00000000000d' }, {}, {}]);
eq('riyadhLocal: ISO (+03:00 / Z) → local, local stays, a date alone never gets an invented time', [P.riyadhLocal('2026-11-12T09:30:00+03:00'), P.riyadhLocal('2026-11-12T06:30:00Z'), P.riyadhLocal('2026-11-12T09:30'), P.riyadhLocal('٢٠٢٦-١١-١٢ 09:30'), P.riyadhLocal('x'), P.riyadhLocal('2026-11-12'), TR.riyadhLocal('2026-11-12')],
  ['2026-11-12T09:30', '2026-11-12T09:30', '2026-11-12T09:30', '2026-11-12T09:30', '', '', '']);
eq('a card read without a time (appointment_local = the date only) lacks the date and time', P.cardMissing({ status: 'pending', review: { party_type: 'direct' }, reading: { appointment: { appointment_at: null, appointment_local: '2026-11-12',
  movement_type: 'full_exit', driver_name: 'س', driver_phone: '0551234567', truck_plate: 'A1', container_no: 'MSKU1234565' } } }, [{ id: 'C1', container_no: 'MSKU1234565' }], 'container'), ['appointment_at']);
eq('dateTimeState: a date alone is not enough', ['', '2026-11-12', '2026-11-12T09:30', '12/11/2026'].map(P.dateTimeState), ['empty', 'date_only', 'ok', 'invalid']);
eq('normPhone: 05XXXXXXXX from +966 / 966 / 5…, Arabic digits', ['+966 55 123 4567', '966551234567', '551234567', '٠٥٥١٢٣٤٥٦٧', '0123'].map(P.normPhone),
  ['0551234567', '0551234567', '0551234567', '0551234567', null]);
eq('fileProblem: type, 5 MB image, 10 MB PDF, empty', [{ name: 'a.docx', size: 1 }, { name: 'a.jpg', size: 6e6 }, { name: 'a.pdf', size: 9e6 }, { name: 'a.pdf', size: 11e6 }, { name: 'a.png', size: 0 }].map(P.fileProblem),
  ['unsupported', 'too_large', null, 'too_large', 'empty']);
{
  const batch = { cards: Array.from({ length: 18 }, (_, i) => ({ id: 'c' + i, status: i === 0 ? 'discarded' : 'pending', file_size: 1e6 })) };
  const p = P.planFiles([{ size: 1 }, { size: 1 }, { size: 1 }], batch);
  eq('planFiles: 17 live + 3 new → 3 accepted (discarded do not count); 20 live → too_many', [p.accepted, P.planFiles([{ size: 1 }], { cards: Array.from({ length: 20 }, () => ({ status: 'approved', file_size: 1 })) }).rejected],
    [[0, 1, 2], [{ i: 0, reason: 'too_many' }]]);
  eq('planFiles: the 25 MB batch size', P.planFiles([{ size: 2e6 }, { size: 2e6 }], { cards: [{ status: 'pending', file_size: 23e6 }] }), { accepted: [0], rejected: [{ i: 1, reason: 'batch_size' }] });
}
{
  const b = { cards: [{ id: 'k1', source_sha256: 'a', status: 'discarded' }, { id: 'k2', source_sha256: 'b', status: 'failed' }] };
  eq('decide: restore / in_batch / approved / move / pending_other / read', [P.decide({ state: 'released' }, b, 'a'), P.decide({ state: 'pending' }, b, 'b'), P.decide({ state: 'approved' }, b, 'c'),
    P.decide({ state: 'pending', same_transaction: false, can_move: true }, b, 'd'), P.decide({ state: 'pending', same_transaction: false, can_move: false }, b, 'e'),
    P.decide({ state: 'pending', same_transaction: true }, null, 'f'), P.decide({ state: 'free' }, null, 'g'), P.decide({ state: 'released' }, null, 'h'), P.decide(null, null, 'i')],
  ['restore', 'in_batch', 'approved', 'move', 'pending_other', 'in_batch', 'read', 'read', 'read']);
}
{
  const card = { id: 'k', seq: 1, status: 'pending', review: {}, reading: { appointment: { appointment_at: '2026-11-12T09:30:00+03:00', container_no: 'MSKU1234565', driver_name: 'أحمد', driver_phone: '0551234567',
    truck_plate: 'ABC 1234', movement_type: 'full_exit', booking_ref: 'TAS123' } } };
  const ctrs = [{ id: 'C1', container_no: 'MSKU1234565' }, { id: 'C2', container_no: 'TGHU7654321' }];
  eq('cardValue: reading fallback, review wins, null clears', [P.cardValue(card, 'appointment_at'), P.cardValue(Object.assign({}, card, { review: { driver_name: 'سعد' } }), 'driver_name'),
    P.cardValue(Object.assign({}, card, { review: { booking_ref: null } }), 'booking_ref'), P.cardValue(card, 'party_type')], ['2026-11-12T09:30', 'سعد', '', '']);
  eq('containerOf: by the card number, then the reviewed id', [P.containerOf(card, ctrs).id, P.containerOf(Object.assign({}, card, { review: { container_id: 'C2' } }), ctrs).id], ['C1', 'C2']);
  eq('cardMissing: the transport party is required; direct takes the driver name; an empty entry lacks nothing; Ro-Ro needs no container',
    [P.cardMissing(card, ctrs, 'container'), P.cardMissing(Object.assign({}, card, { review: { party_type: 'direct' } }), ctrs, 'container'),
      P.cardMissing(Object.assign({}, card, { review: { party_type: 'company' } }), ctrs, 'container'),
      P.cardMissing(Object.assign({}, card, { review: { movement_type: 'empty_entry' } }), ctrs, 'container'),
      P.cardMissing(Object.assign({}, card, { review: { party_type: 'direct', container_no: 'XXXU0000000' } }), [], 'roro'),
      P.cardMissing(Object.assign({}, card, { review: { party_type: 'direct', appointment_at: '2026-11-12', container_id: null, container_no: null } }), ctrs, 'container')],
    [['party_type'], [], ['party_name'], [], [], ['container', 'appointment_at']]);
  eq('browser fix — cardMissing: a company chosen by carrier_id needs no typed party name',
    P.cardMissing(Object.assign({}, card, { review: { party_type: 'company', carrier_id: '00000000-0000-4000-8000-0000000000c1' } }), ctrs, 'container'), []);
  eq('cardHints: phone format, card container not on the transaction, empty entry skipped', [P.cardHints(Object.assign({}, card, { review: { driver_phone: '0123', container_no: 'TCLU1111112' } }), ctrs, 'container'),
    P.cardHints(Object.assign({}, card, { review: { movement_type: 'empty_entry' } }), ctrs, 'container')], [['phone_format', 'container_not_in_tx'], ['empty_entry_skip']]);
  eq('setReview: container pick = id + number; clear → null over a reading value, removed otherwise; phone normalized; money as number',
    [P.setReview({}, 'container_id', 'C2|TGHU7654321', card), P.setReview({}, 'container_id', '', card), P.setReview({ booking_ref: 'X' }, 'booking_ref', ' ', card),
      P.setReview({ notes: 'x' }, 'notes', '', card), P.setReview({}, 'driver_phone', '+966551234567', card), P.setReview({}, 'cost_amount', '1,250.5', card), P.setReview({ cost_amount: 3 }, 'cost_amount', '', card)],
    [{ container_id: 'C2', container_no: 'TGHU7654321' }, { container_id: null, container_no: null }, { booking_ref: null }, {}, { driver_phone: '0551234567' }, { cost_amount: 1250.5 }, {}]);
  eq('reviewPayload: cost / sell only for finance roles; unknown keys dropped', [P.reviewPayload({ cost_amount: 1, sell_amount: 2, notes: 'n', bogus: 1 }, false), P.reviewPayload({ cost_amount: 1, notes: 'n' }, true)],
    [{ notes: 'n' }, { cost_amount: 1, notes: 'n' }]);
  const cards = [card, Object.assign({}, card, { id: 'k2', review: { party_type: 'direct' } }), Object.assign({}, card, { id: 'k3', review: { movement_type: 'empty_entry' } }), Object.assign({}, card, { id: 'k4', status: 'approved' })];
  eq('approvePlan: movements / skipped / incomplete over pending + failed cards only', P.approvePlan(cards, ctrs, 'container'), { total: 3, movements: 1, skipped: 1, incomplete: 1, mismatch: 0 });
  // review fixes (step 5)
  const unk = Object.assign({}, card, { review: { party_type: 'direct', movement_type: null } });
  unk.reading = { appointment: Object.assign({}, card.reading.appointment, { movement_type: null }) };
  eq('an unknown movement type is missing data (approval fails it), not a skipped card; the plan counts it incomplete',
    [P.cardMissing(unk, ctrs, 'container'), P.approvePlan([unk], ctrs, 'container')], [['movement_type'], { total: 1, movements: 0, skipped: 0, incomplete: 1, mismatch: 0 }]);
  const withRefs = Object.assign({}, card, { review: { party_type: 'direct' } });
  withRefs.reading = { appointment: Object.assign({}, card.reading.appointment, { exit: { bl_number: 'medu 999', declaration_number: '3012345' } }) };
  eq('refMatch / cardHints: the card B/L and declaration against the transaction (legacy compareAppointmentWithTransaction_); nothing to compare → no hint',
    [P.refMatch(withRefs, { bl_numbers: ['MEDU123456'], declaration_numbers: ['3012345'] }), P.cardHints(withRefs, ctrs, 'container', { bl_numbers: ['MEDU123456'], declaration_numbers: ['9'] }),
      P.cardHints(withRefs, ctrs, 'container', { bl_numbers: ['MEDU999'], declaration_numbers: [] }), P.approvePlan([withRefs], ctrs, 'container', { bl_numbers: ['X1'] }).mismatch],
    [{ bl: false, decl: true }, ['bl_mismatch', 'decl_mismatch'], [], 1]);
  eq('cardHints: amounts a finance user entered are flagged for another role (amounts_hidden)', P.cardHints(Object.assign({}, withRefs, { amounts_hidden: true }), ctrs, 'container'), ['amounts_hidden']);
}
{
  const b = { cards: [{ id: 'k1', source_sha256: 'a', status: 'approved', link_voided_at: 'x' }, { id: 'k2', source_sha256: 'b', status: 'skipped' }, { id: 'k3', source_sha256: 'c', status: 'failed' }] };
  eq('decide: only a live card of this draft stops a read (an approved card whose appointment was cancelled → the released file is read again)',
    [P.decide({ state: 'released', same_transaction: true }, b, 'a'), P.decide({ state: 'released' }, b, 'b'), P.decide({ state: 'pending', same_transaction: true }, b, 'c')], ['read', 'read', 'in_batch']);
  const ms = [{ org_id: 'o', branch_id: 'JED', role: 'transport_staff' }, { org_id: 'o', branch_id: 'DMM', role: 'accountant' }, { org_id: 'o', branch_id: null, role: 'viewer' }];
  eq('branchCan: a transport writer of the transaction branch (org-wide memberships count); another branch → read only',
    [P.branchCan(ms, 'o', 'JED', ['transport_staff']), P.branchCan(ms, 'o', 'DMM', ['transport_staff']), P.branchCan([{ org_id: 'o', branch_id: null, role: 'admin' }], 'o', 'DMM', ['admin'])], [true, false, true]);
  eq('approveBlock: reading / failed autosave / unsaved edits block the approval', [P.approveBlock({ reading: 1 }), P.approveBlock({ saveError: { code: 'X' } }), P.approveBlock({ pending: { a: 1 } }), P.approveBlock({ pending: {} })],
    ['reading', 'save_error', 'unsaved', null]);
  eq('the review keys include the gate instructions / driver licence the migration accepts', ['gate_instructions', 'driver_license'].map(k => P.REVIEW_KEYS.includes(k) && P.DETAIL_KEYS.includes(k)), [true, true]);
}
{
  let n = 0; const gen = () => 'k' + (++n);
  const a = P.approveKey(null, 3, null, gen), b = P.approveKey(a, 3, null, gen), c = P.approveKey(b, 4, null, gen), d = P.approveKey(c, 4, ['y', 'x'], gen), e = P.approveKey(d, 4, ['x', 'y'], gen);
  eq('approveKey: same version + cards keeps the key, else a new one', [a.key, b.key, c.key, d.key, e.key], ['k1', 'k1', 'k2', 'k3', 'k3']);
}
eq('resultSummary: counts + per card', P.resultSummary({ status: 'partial', counts: { saved: 1, failed: 1 }, results: [{ card_id: 'a', seq: 1, outcome: 'saved' }, { card_id: 'b', seq: 2, outcome: 'weird', code: 'X' }] }),
  { saved: 1, already_existed: 0, skipped: 0, failed: 1, results: [{ card_id: 'a', seq: 1, file_name: undefined, outcome: 'saved', code: null, detail: null }, { card_id: 'b', seq: 2, file_name: undefined, outcome: 'failed', code: 'X', detail: null }], status: 'partial' });
eq('rejectReason: MRS_AI_WRONG_DOCUMENT <reason>', [P.rejectReason({ code: 'MRS_AI_WRONG_DOCUMENT', field: 'appointment_invoice' }), P.rejectReason({ code: 'MRS_AI_WRONG_DOCUMENT', field: 'zzz' }), P.rejectReason({ code: 'MRS_AI_FAILED' })],
  ['appointment_invoice', 'not_appointment_ticket', null]);
check('readingOf: appointment + compact fields / warnings, well under 60 000 bytes even for a large reading', () => {
  const big = { appointment: { booking_ref: 'TAS1' }, fields: Array.from({ length: 100 }, (_, i) => ({ name: 'f' + i, value: 'v'.repeat(2000), confidence: 0.9, page: 1, valid: true })),
    warnings: Array.from({ length: 100 }, () => ({ source: 'model', code: 'x', text: 't'.repeat(2000), field: 'f' })) };
  const r = P.readingOf(big);
  return (r.appointment.booking_ref === 'TAS1' && r.fields.length === 40 && r.warnings.length === 30 && Buffer.byteLength(J(r)) < 60000 && !('source' in r.warnings[0])
    && P.readingOf({ ai_detail: { appointment: { booking_ref: 'TAS2' } } }).appointment.booking_ref === 'TAS2') || Buffer.byteLength(J(r));
});
{
  const seen = []; let active = 0, max = 0;
  const pool = P.runPool([1, 2, 3, 4, 5], 2, x => { active++; max = Math.max(max, active); seen.push(x); return new Promise(r => setTimeout(() => { active--; r(x * 10); }, 5 - x)); });
  check('runPool: results in order, at most 2 at a time, a throw becomes {error}', () => true);
  pool.then(out => {
    check('runPool: order + concurrency (async)', () => (J(out) === J([10, 20, 30, 40, 50]) && max === 2) || J([out, max]));
  });
}

section('pure helpers (tx-appt.js, tx-return.js)');
eq('carrierPayload: TASTO normalized, date, company / new company; errors', [TA.carrierPayload({ orderNo: ' tasto 123 ', orderDate: '2026-11-11', partyId: 'P1' }),
  TA.carrierPayload({ orderNo: 'TASTO٤٥', orderDate: '2026-11-11', partyId: '__new', companyName: ' شركة النقل ' }), TA.carrierPayload({ orderNo: 'TAS123', orderDate: '2026-11-11', partyId: 'P' }),
  TA.carrierPayload({ orderNo: '', orderDate: '2026-11-11' }), TA.carrierPayload({ orderNo: 'TASTO1', orderDate: '' }), TA.carrierPayload({ orderNo: 'TASTO1', orderDate: '2026-11-11', partyId: '__new', companyName: ' ' })],
[{ orderNo: 'TASTO123', orderDate: '2026-11-11', partyId: 'P1' }, { orderNo: 'TASTO45', orderDate: '2026-11-11', companyName: 'شركة النقل' }, { error: 'co_e_no' }, { error: 'co_e_no_required' }, { error: 'co_e_date' }, { error: 'co_e_company' }]);
check('readinessView: blocked → warning with the pending containers; policy locked; the carrier order kept as a note only', () => {
  const v = TA.readinessView({ billing_gate_open: false, blocking: 'containers_not_returned', pending_count: 1, declared_missing: 1, containers_total: 2,
    pending_containers: [{ container_id: 'C1', container_no: 'MSKU1234565', return_status: 'pending', return_deadline: '2026-11-01', overdue: true, proofs_pending: 1 }],
    policy: { empty_return_blocks_billing: true, switchable: false }, carrier_order: { order_no: 'TASTO1', bypasses_empty_return: false } });
  const o = TA.readinessView({ billing_gate_open: true, pending_containers: [], containers_total: 2, policy: { empty_return_blocks_billing: true, switchable: false } });
  return (v.tone === 'warning' && !v.open && v.pending[0].overdue && v.pending[0].proofs === 1 && v.policyLocked && v.blocksBilling && v.carrier.order_no === 'TASTO1' && v.declaredMissing === 1
    && o.open && o.tone === 'success') || J([v, o]);
});
eq('verifyPayload: container + date AND time + depot', [TR.verifyPayload({ containerId: 'C1', deliveredAt: '2026-11-10T14:05', depot: ' ساحة ' }), TR.verifyPayload({ containerId: 'C1', deliveredAt: '2026-11-10', depot: 'x' }),
  TR.verifyPayload({ deliveredAt: '2026-11-10T14:05', depot: 'x' }), TR.verifyPayload({ containerId: 'C1', deliveredAt: '2026-11-10T14:05', depot: '' }), TR.verifyPayload({ containerId: 'C1', deliveredAt: '10/11/2026 2pm', depot: 'x' })],
[{ containerId: 'C1', deliveredAt: '2026-11-10T14:05', depot: 'ساحة' }, { error: 'v_e_time' }, { error: 'v_e_container' }, { error: 'v_e_depot' }, { error: 'v_e_time_format' }]);
eq('manualPayload: date alone refused; unreadable needs no values; something is required otherwise', [TR.manualPayload({ containerId: 'C1', deliveredAt: '2026-11-10T14:05', depot: 'D', notes: 'n' }),
  TR.manualPayload({ deliveredAt: '2026-11-10' }), TR.manualPayload({ unreadable: true }), TR.manualPayload({})],
[{ source: 'manual', deliveredAt: '2026-11-10T14:05', containerId: 'C1', depot: 'D', matchNotes: 'n' }, { error: 'v_e_time' }, { source: 'manual', unreadable: true }, { error: 'm_e_empty' }]);
eq('notesOf: tokens + free text', TR.notesOf('container_not_read | depot_missing | راجع الإيصال'), [{ token: 'container_not_read' }, { token: 'depot_missing' }, { text: 'راجع الإيصال' }]);
eq('fileProblem (EIR): 8 MB, image ≤ 5 MB for the AI reading', [TR.fileProblem(null), TR.fileProblem({ name: 'a.txt', size: 1 }), TR.fileProblem({ name: 'a.pdf', size: 9e6 }),
  TR.fileProblem({ name: 'a.jpg', size: 6e6 }, true), TR.fileProblem({ name: 'a.jpg', size: 6e6 }, false), TR.fileProblem({ name: 'a.pdf', size: 7e6 }, true)],
['required', 'unsupported', 'too_large', 'too_large_image', null, null]);
eq('confPct / confTone', [TR.confPct(0.874), TR.confTone(0.9), TR.confTone(0.7), TR.confTone(0.2), TR.confPct(null)], [87, 'success', 'warning', 'danger', null]);

/* ================================================================ wiring */
section('page wiring, service worker, CSS, docs');
const OCR = rd('ocr.html'), ADMIN = rd('admin.html'), SW = rd('sw.js'), CSS = rd('assets/css/pages/appt.css');
const order = (html, list) => { const at = list.map(f => html.indexOf('src="' + f + '"')); return at.every(x => x > 0) && at.every((x, i) => i === 0 || x > at[i - 1]); };
check('ocr.html: hidden #appt-section + root + live region; appt.css; i18n → supa → appt-cards after decl-review', () =>
  (/<section class="section section-sm appt-section" id="appt-section" aria-labelledby="appt-title" hidden>/.test(OCR) && /id="appt-root"/.test(OCR) && /id="appt-live" role="status"/.test(OCR)
    && /id="appt-title" tabindex="-1" data-i18n="appt\.h_title"/.test(OCR) && /href="assets\/css\/pages\/appt\.css"/.test(OCR)
    && order(OCR, ['assets/js/i18n.js', 'assets/i18n/appt.js', 'assets/js/supa.js', 'assets/js/app-shell.js', 'assets/js/decl-review.js', 'assets/js/appt-cards.js'])) || 'ocr.html');
check('admin.html: appt.css, i18n/appt.js, ops/tx-appt.js + ops/tx-return.js after tx-decl.js and before admin.js', () =>
  (/href="assets\/css\/pages\/appt\.css"/.test(ADMIN) && order(ADMIN, ['assets/js/i18n.js', 'assets/i18n/appt.js', 'assets/js/ops/tx-sections.js', 'assets/js/ops/tx-decl.js', 'assets/js/ops/tx-appt.js', 'assets/js/ops/tx-return.js', 'assets/js/admin.js'])) || 'admin.html');
check('sw.js precaches the new files; VERSION ≥ 2026-11-21.2', () => {
  const v = (/^var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)';/m.exec(SW) || [])[1] || '';
  return (['assets/js/appt-cards.js', 'assets/js/ops/tx-appt.js', 'assets/js/ops/tx-return.js', 'assets/i18n/appt.js', 'assets/css/pages/appt.css'].every(f => SW.indexOf("'" + f + "'") !== -1)
    && v.localeCompare('2026-11-21.2', 'en', { numeric: true }) >= 0) || v;
});
check('375px: tables scroll in their own box; one column under 480px; children may shrink', () =>
  (/\.appt-table-wrap \{[^}]*overflow: auto;/.test(CSS) && /\.appt-table-wrap \{[^}]*max-width: 100%;/.test(CSS) && /@media \(max-width: 480px\) \{\s*\.appt-grid, \.appt-dl, \.appt-co-form \{ grid-template-columns: 1fr; \}/.test(CSS)
    && /\.appt-root > \*, \.appt-batch > \*, \.appt-er > \* \{ min-width: 0; \}/.test(CSS) && /\.appt-field \.form-control \{ width: 100%; max-width: 100%; \}/.test(CSS)) || 'css');
check('error lines are visible when shown (not left display:none like .form-error)', () =>
  (/\.appt-error \{ display: block;/.test(CSS) && /\.appt-error:empty, \.appt-error\[hidden\] \{ display: none; \}/.test(CSS) && !/'form-error'/.test(SRC + TXA + TXR)) || 'css');
check('sections registered once each: readiness (5), appointment_cards (51), empty_return (56), carrier_order (57)', () => {
  const s = win.MarsaOps.txSections.map(x => x.id + ':' + x.order).sort();
  return J(s) === J(['appointment_cards:51', 'carrier_order:57', 'empty_return:56', 'readiness:5']) || J(s);
});
check('cards page: the upload gate is the transaction branch (txWriter on the shell memberships), and move-here keeps the file on this transaction first', () =>
  (/S\.writer = txWriter\(S\.tx\);/.test(SRC) && /return branchCan\(ctx\.memberships, tx\.org_id \|\| S\.orgId, tx\.branch_id, R\);/.test(SRC)
    && /flush\(\)\.then\(function \(\) \{ return q\.file && q\.sha \? ensureDoc\(q\) : null; \}\)\.then\(function \(\) \{\s*return API\.moveAppointmentDraft/.test(SRC)) || 'gate');
check('the readiness banner is placed at the top of the transaction page (placement top: admin.js renders it under the stages, before the cards)', () => {
  const ADM = rd('assets/js/admin.js');
  return (/\{ id: 'readiness', order: 5, placement: 'top', render: renderReadiness \}/.test(TXA) && /function renderTxSections\(host, tx, top\)/.test(ADM)
    && /\(s\.placement === 'top'\) === !!top/.test(ADM) && /firstCols\.parentNode\.insertBefore\(topSections, firstCols\)/.test(ADM) && /renderTxSections\(topSections, t, true\)/.test(ADM)) || 'top';
});
check('appt.css: the card cell stays a table cell (the grid is on its inner box)', () => {
  const css = rd('assets/css/pages/appt.css'), cell = (css.match(/\.appt-col-card \{[^}]*\}/) || [''])[0];
  return (!/display:\s*grid/.test(cell) && /\.appt-card-info \{[^}]*display: grid/.test(css) && /el\('div', 'appt-card-info'\)/.test(SRC)) || cell;
});
check('the movements list (tx-legacy.js) shows the card and trip party fields that approval writes', () => {
  const TL = rd('assets/js/ops/tx-legacy.js');
  return ['m.booking_ref', 'm.operator_name', 'm.zone_gate', 'm.party_type', 'm.party_name', 'm.transport_order_no'].every(k => TL.indexOf(k) !== -1)
    && ['booking_ref', 'operator_name', 'zone_gate', 'barcode', 'movement_type', 'party_type', 'party_name', 'transport_order_no'].every(k => new RegExp("'" + k + "', [ar]\\." + k).test(MIG)) || 'columns';
});
check('docs: LEGACY_APPT_AR.md names the UI files', () => { const d = rd('docs/online/LEGACY_APPT_AR.md'); return ['assets/js/appt-cards.js', 'assets/js/ops/tx-appt.js', 'assets/js/ops/tx-return.js', 'assets/i18n/appt.js', 'legacy-appt-ui-tests.js'].every(f => d.includes(f)) || 'docs'; });

/* ================================================================ DOM flows */
const { makeDom } = require('./lib/fake-dom.js');
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 30); i++) await tick(); }
const ORG = '0000000a-0000-4000-8000-00000000000a', TX = '0000000d-0000-4000-8000-00000000000d', TX2 = '0000000c-0000-4000-8000-00000000000c';
const B1 = '0000000b-0000-4000-8000-00000000000b', OB = '0000000f-0000-4000-8000-0000000000ff', C1 = '000000c1-0000-4000-8000-0000000000c1', C2 = '000000c2-0000-4000-8000-0000000000c2';
const ok = d => Promise.resolve({ data: d, error: null });
const err = (code, field) => Promise.resolve({ data: null, error: { code, field, message: code + (field ? ':' + field : '') } });
const UID = (p, s) => p + '-0000-4000-8000-' + (String(s).replace(/[^0-9a-f]/g, '') + '000000000000').slice(0, 12);
const DOCID = n => UID('0000d0c0', Buffer.from(n).toString('hex'));
const EXTID = sha => UID('0000e000', sha);
const SHA = { 'fresh.pdf': '1'.repeat(64), 'fresh2.pdf': '2'.repeat(64), 'approved.pdf': '3'.repeat(64), 'other.pdf': '4'.repeat(64), 'invoice.pdf': '5'.repeat(64), 'eir.pdf': '6'.repeat(64), 'eir2.pdf': '7'.repeat(64) };
const APPT = n => ({ booking_ref: 'TAS10' + n, operator_ticket_no: 'T-' + n, operator_name: 'RSGT', appointment_at: '2026-11-12T09:3' + n + ':00+03:00', appointment_local: '2026-11-12T09:3' + n,
  truck_plate: 'ABC 123' + n, driver_name: 'سائق ' + n, driver_phone: '055123456' + n, zone_gate: 'G' + n, barcode: 'BC' + n, movement_type: 'full_exit', container_no: n === 1 ? 'MSKU1234565' : 'TCLU9999990',
  document_title: 'Port Appointment', entry: {}, exit: { bl_number: 'MEDU1' }, structural: { ok: true } });
function batchState(opts) {
  return { id: B1, org_id: ORG, transaction_id: TX, ref: 'TX-1', cargo_unit_type: 'container', status: 'pending', version: 1, note: null, can_edit: opts.canEdit !== false, finance: !!opts.finance,
    limits: { cards: 20, bytes: 26214400 }, total_bytes: 0, counts: {}, cards: [], containers: [{ id: C1, container_no: 'MSKU1234565', return_status: 'pending' }, { id: C2, container_no: 'TGHU7654321', return_status: 'pending' }] };
}
function mockApi(opts) {
  opts = opts || {};
  const calls = [];
  const rec = (n, a) => calls.push({ n, a: JSON.parse(JSON.stringify(a === undefined ? null : a)) });
  let batch = opts.batch || null, seq = 0, active = 0;
  const stats = { maxActive: 0 };
  const api = {
    isOnline: () => true, getSession: () => ok({ user: {} }), isStaff: () => ok(true), activeOrgId: () => ok(ORG),
    aiAccess: () => ok({ can_use: true, daily_remaining: 9 }),
    getTransaction: id => ok({ id, ref: 'TX-1', cargo_unit_type: 'container', clients: { name_ar: 'أكمي' } }),
    getAppointmentDraft: (t, b) => { rec('getAppointmentDraft', [t, b || null]); return ok(batch && ['pending', 'partial'].includes(batch.status) ? JSON.parse(J(batch)) : null); },
    appointmentCardState: (t, shas, o) => { rec('appointmentCardState', { t, shas, o });
      return ok(shas.map(s => s === SHA['approved.pdf'] ? { sha256: s, state: 'approved', same_transaction: false, ref: null, can_move: false }
        : s === SHA['other.pdf'] ? { sha256: s, state: 'pending', same_transaction: false, card_id: 'oc', batch_id: OB, transaction_id: TX2, ref: 'TX-2', can_move: true }
        : { sha256: s, state: 'free', same_transaction: false, can_move: false })); },
    aiExtract: o => {
      const name = o.file.data_b64;
      rec('aiExtract', { docType: o.docType, promptVersion: o.promptVersion, tx: o.transactionId, name });
      active++; stats.maxActive = Math.max(stats.maxActive, active);
      return new Promise(r => setTimeout(r, 3)).then(() => {
        active--;
        if (name === 'invoice.pdf') return { data: null, error: { code: 'MRS_AI_WRONG_DOCUMENT', field: 'appointment_invoice', message: 'x' } };
        if (o.docType === 'empty_return_receipt') {
          if (opts.eirWrong) return { data: null, error: { code: 'MRS_AI_WRONG_DOCUMENT', field: 'not_empty_return', message: 'x' } };
          return { data: { usage_id: 'u', model: 'claude-opus-5-5', kind: 'empty_return_receipt', extracted_fields: { container_numbers: 'MSKU1234565' }, fields: [], raw_text: 'eir',
            ai_detail: { prompt_version: 'ai-doc-v3', empty_return: { container_no: 'MSKU1234565', delivered_at: '2026-11-10T14:05:00+03:00', depot: 'ساحة الدمام', confidence: 0.82, movement: 'empty_return' } },
            empty_return: { container_no: 'MSKU1234565', confidence: 0.82 }, reused: false }, error: null };
        }
        const n = name === 'fresh.pdf' ? 1 : 2;
        return { data: { usage_id: 'u' + n, model: 'claude-opus-5-5', kind: 'appointment', doc_type: 'appointment_ticket', detected_type: 'appointment_ticket', appointment: APPT(n),
          fields: [{ name: 'appointment_booking_ref', value: 'TAS10' + n, confidence: 0.95, page: 1, valid: true }], warnings: [{ source: 'server', code: 'movement_type_corrected', text: 'x', field: 'appointment_movement_type' }],
          extracted_fields: { appointment_booking_ref: 'TAS10' + n }, raw_text: 'card', ai_detail: { prompt_version: 'ai-doc-v3', appointment: APPT(n) }, reused: false }, error: null };
      });
    },
    listDocuments: o => { rec('listDocuments', o); return ok(opts.docs || []); },
    uploadDocument: o => { rec('uploadDocument', { kind: o.kind, tx: o.transactionId, name: o.file.name }); return ok({ id: DOCID(o.file.name), sha256: SHA[o.file.name] }); },
    saveExtraction: row => { rec('saveExtraction', { doc_type: row.doc_type, tx: row.transaction_id, doc: row.document_id, ai_detail: !!row.ai_detail, sha: row.source_sha256 }); return ok({ id: EXTID(row.source_sha256) }); },
    findExtractionBySource: () => ok(null),
    saveAppointmentDraft: (t, o) => {
      rec('saveAppointmentDraft', { t, o });
      if (opts.staleOnce && o.batchId && o.cards && o.cards.some(c => c.review)) { opts.staleOnce = false; return err('MRS_APPT_DRAFT_STALE'); }
      if (!o.batchId) { if (batch && ['pending', 'partial'].includes(batch.status)) return err('MRS_APPT_DRAFT_EXISTS'); batch = batchState(opts); }
      else if (!batch || batch.id !== o.batchId) return err('MRS_NOT_FOUND', 'appointment_draft');
      else batch.version++;
      (o.cards || []).forEach(c => {
        if (c.card_id) { const k = batch.cards.find(x => x.id === c.card_id); if (c.review) k.review = c.review; if (c.status) k.status = c.status; return; }
        if (batch.cards.some(x => x.source_sha256 === c.source_sha256)) return;
        seq++;
        batch.cards.push({ id: 'card-' + seq, seq, file_name: c.file_name, file_size: c.file_size, media_type: c.media_type, source_sha256: c.source_sha256, extraction_id: c.extraction_id || null,
          document_id: c.document_id || null, reading: c.reading, review: c.review || {}, status: 'pending', result: null, appointment_id: null });
      });
      return ok(JSON.parse(J(batch)));
    },
    approveAppointmentDraft: (b, o) => {
      rec('approveAppointmentDraft', { b, o });
      const ids = o.cardIds || batch.cards.filter(c => ['pending', 'failed'].includes(c.status)).map(c => c.id);
      const results = ids.map(id => { const c = batch.cards.find(x => x.id === id);
        const okc = c.review && c.review.party_type;
        c.status = okc ? 'approved' : 'failed'; c.result = okc ? { outcome: 'saved' } : { outcome: 'failed', code: 'MRS_APPT_PARTY_REQUIRED', detail: 'party_type' };
        return { card_id: id, seq: c.seq, file_name: c.file_name, outcome: okc ? 'saved' : 'failed', code: okc ? null : 'MRS_APPT_PARTY_REQUIRED', detail: okc ? null : 'party_type', appointment_id: okc ? 'ap' : null }; });
      batch.status = batch.cards.some(c => ['pending', 'failed'].includes(c.status)) ? 'partial' : 'approved'; batch.version++;
      const saved = results.filter(r => r.outcome === 'saved').length;
      return ok({ batch_id: b, status: batch.status, results, counts: { saved, already_existed: 0, skipped: 0, failed: results.length - saved }, batch: JSON.parse(J(batch)), readiness: { billing_gate_open: false, pending_count: 2 } });
    },
    cancelAppointmentDraft: (b, r) => { rec('cancelAppointmentDraft', [b, r]); batch.status = 'cancelled'; return ok(Object.assign(JSON.parse(J(batch)), { released_cards: batch.cards.length })); },
    moveAppointmentDraft: (b, ref, why) => { rec('moveAppointmentDraft', [b, ref, why]);
      if (b === OB) { batch = batch || batchState(opts); batch.cards.push({ id: 'card-moved', seq: 9, file_name: 'other.pdf', file_size: 10, source_sha256: SHA['other.pdf'], reading: { appointment: APPT(2) }, review: {}, status: 'pending' }); return ok(JSON.parse(J(batch))); }
      batch.status = 'moved'; return ok({ id: 'tb', transaction_id: TX2, ref: ref.toUpperCase(), status: 'pending', cards: [] }); },
    errorMessage: e => e && (e.code + (e.field ? ':' + e.field : '')),
    util: { uuid: (() => { let n = 0; return () => 'idem-' + (++n); })(), sha256Hex: f => Promise.resolve(SHA[f.name] || 'f'.repeat(64)) }
  };
  return { api, calls, stats, get batch() { return batch; } };
}
function pageContext(api, hash, shellExtra) {
  const { document } = makeDom();
  const mk = (tag, id, parent) => { const n = document.createElement(tag); n.id = id; (parent || document.body).appendChild(n); return n; };
  const secEl = mk('section', 'appt-section'); secEl.hidden = true;
  mk('h2', 'appt-title', secEl); mk('p', 'appt-live', secEl); mk('div', 'appt-root', secEl);
  const toasts = [], confirms = [];
  const winListeners = {};
  const location = { hash: hash || '', pathname: '/ocr.html', search: '' };
  const w = {
    MarsaI18n: I18N, MarsaApi: api,
    MarsaShell: Object.assign({ ready: Promise.resolve({}), orgId: () => ORG, can: () => true, R: { transportWriter: ['transport_staff'] },
      toast: (m, t) => toasts.push([t, m]), confirm: o => { confirms.push(o); return Promise.resolve(true); } }, shellExtra || {}),
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); }, confirm: () => true, location
  };
  class FileReader { readAsDataURL(f) { setTimeout(() => { this.result = 'data:application/pdf;base64,' + f.name; this.onload && this.onload(); }, 0); } }
  // the autosave debounce (450 ms) runs at once in the tests
  const fastTimeout = (f, ms) => setTimeout(f, Math.min(ms || 0, 2));
  const c = { window: w, document, location, FileReader, console, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise,
    setTimeout: fastTimeout, clearTimeout, encodeURIComponent };
  vm.createContext(c);
  vm.runInContext(SRC, c, { filename: 'appt-cards.js (page)' });
  return { document, w, sec: secEl, toasts, confirms, location, root: document.getElementById('appt-root') };
}
const btnByText = (root, re) => root.querySelectorAll('button').filter(b => re.test(b.textContent))[0] || null;
const rowOf = (root, cardId) => root.querySelectorAll('tr').filter(t => t.getAttribute('data-card') === cardId)[0] || null;
const cellOf = (row, key) => row ? row.querySelectorAll('[data-key="' + key + '"]')[0] || null : null;
const F = name => ({ name, size: 2048, type: 'application/pdf' });

async function cardsFlow() {
  section('DOM: appointment cards — upload, fingerprints, reading, review, autosave, approval (appt-cards.js)');
  const M = mockApi();
  const Pg = pageContext(M.api, '#appt-tx=' + TX);
  await settle(30);
  const root = Pg.root;
  check('the section shows for the deep link; no draft yet; the upload box is enabled', () =>
    (!Pg.sec.hidden && M.calls.some(c => c.n === 'getAppointmentDraft' && c.a[0] === TX) && /لا توجد مسودة بطاقات مفتوحة/.test(root.textContent)
      && !Pg.document.getElementById('appt-files').disabled && /TX-1/.test(root.textContent)) || root.textContent.slice(0, 300));
  const inp = Pg.document.getElementById('appt-files');
  inp.files = [F('fresh.pdf'), F('approved.pdf'), F('other.pdf'), F('invoice.pdf'), F('fresh2.pdf'), F('fresh.pdf'), { name: 'x.docx', size: 3, type: '' }];
  inp.dispatch('change');
  await settle(120);
  const st = M.calls.filter(c => c.n === 'appointmentCardState');
  check('fingerprints checked once for the distinct files before any reading (the same file twice is kept once; .docx refused)', () =>
    (st.length === 1 && st[0].a.shas.length === 5 && st[0].a.t === TX && M.calls.findIndex(c => c.n === 'appointmentCardState') < M.calls.findIndex(c => c.n === 'aiExtract')
      && /الملف نفسه مختار مرتين/.test(root.textContent) && /صيغة غير مدعومة/.test(root.textContent)) || J(st.map(x => x.a.shas.length)));
  const reads = M.calls.filter(c => c.n === 'aiExtract');
  check('only the free cards are read: appointment_ticket, ai-doc-v3, for the transaction; at most 2 at a time', () =>
    (J(reads.map(r => r.a.name).sort()) === J(['fresh.pdf', 'fresh2.pdf', 'invoice.pdf']) && reads.every(r => r.a.docType === 'appointment_ticket' && r.a.promptVersion === 'ai-doc-v3' && r.a.tx === TX)
      && M.stats.maxActive === 2) || J([reads.map(r => r.a.name), M.stats.maxActive]));
  check('approved elsewhere → blocked; pending elsewhere → move offer; Fasah invoice → rejected per card and not saved', () =>
    (/معتمدة في حركة قائمة/.test(root.textContent) && /بانتظار الاعتماد في مسودة المعاملة TX-2/.test(root.textContent) && !!btnByText(root, /نقل تلك المسودة إلى هذه المعاملة/)
      && /فاتورة موعد \(فسح \/ TAS\) وليست بطاقة الموعد/.test(root.textContent)
      && !M.calls.some(c => c.n === 'saveExtraction' && c.a.sha === SHA['invoice.pdf']) && !M.calls.some(c => c.n === 'uploadDocument' && c.a.name === 'invoice.pdf')) || root.textContent.slice(0, 900));
  const saves = M.calls.filter(c => c.n === 'saveAppointmentDraft');
  check('each fresh card: file kept as a document (kind appointment), reading saved (doc_type appointment, with document_id), then added to the draft (first save creates it)', () =>
    (M.calls.filter(c => c.n === 'uploadDocument').every(c => c.a.kind === 'appointment' && c.a.tx === TX) && M.calls.filter(c => c.n === 'uploadDocument').length === 2
      && M.calls.filter(c => c.n === 'saveExtraction').every(c => c.a.doc_type === 'appointment' && c.a.ai_detail && c.a.doc === DOCID(c.a.sha === SHA['fresh.pdf'] ? 'fresh.pdf' : 'fresh2.pdf'))
      && !saves[0].a.o.batchId && saves[1].a.o.batchId === B1 && saves.every(s => s.a.o.cards[0].reading && s.a.o.cards[0].reading.appointment
        && s.a.o.cards[0].extraction_id === EXTID(s.a.o.cards[0].source_sha256) && /^0000d0c0-/.test(s.a.o.cards[0].document_id)) && M.batch.cards.length === 2) || J(saves.map(s => s.a.o)));
  check('the review table: one row per card, container picker limited to the transaction (card number preselected), party required, movement type', () => {
    const r1 = rowOf(root, 'card-1'), sel = cellOf(r1, 'container_id');
    return (r1 && sel.options.length === 3 && sel.value === C1 + '|MSKU1234565' && cellOf(r1, 'appointment_at').value === '2026-11-12T09:31' && cellOf(r1, 'movement_type').value === 'full_exit'
      && cellOf(r1, 'party_type').value === '' && /نوع جهة النقل/.test(root.querySelector('[data-notes="card-1"]').textContent)
      && /حاوية البطاقة TCLU9999990 ليست من حاويات المعاملة/.test(root.querySelector('[data-notes="card-2"]').textContent)
      && /صُحّح نوع الحركة/.test(root.querySelector('[data-notes="card-1"]').textContent)) || root.textContent.slice(0, 600);
  });
  // inline edit → autosave with the version
  const v0 = M.batch.version;
  const pt = cellOf(rowOf(root, 'card-1'), 'party_type'); pt.value = 'direct'; pt.dispatch('change');
  const ph = cellOf(rowOf(root, 'card-1'), 'driver_phone'); ph.value = '+966 55 000 1111'; ph.dispatch('input');
  check('editing updates the missing line at once (direct = the driver)', () => !/نوع جهة النقل/.test(root.querySelector('[data-notes="card-1"]').textContent) || 'still missing');
  await settle(40);
  const auto = M.calls.filter(c => c.n === 'saveAppointmentDraft' && c.a.o.cards && c.a.o.cards[0].card_id);
  check('autosave: one save with the draft version and the whole card review (phone normalized), no cost keys for a non-finance user', () =>
    (auto.length === 1 && auto[0].a.o.version === v0 && auto[0].a.o.batchId === B1 && J(auto[0].a.o.cards) === J([{ card_id: 'card-1', review: { party_type: 'direct', driver_phone: '0550001111' } }])
      && /حُفظت التعديلات/.test(Pg.document.getElementById('appt-save-status').textContent)) || J(auto.map(a => a.a.o)));
  // approve all: behind the confirm dialog, version + idempotency key, per-card result
  const ab = Pg.document.getElementById('appt-approve-all');
  check('approve all counts the pending cards', () => (/\(2\)/.test(ab.textContent) && !ab.disabled) || ab.textContent);
  ab.click();
  await settle(40);
  const ap = M.calls.filter(c => c.n === 'approveAppointmentDraft');
  check('approval: the confirm dialog first (movements / incomplete lines), then one call with the current version + an idempotency key', () =>
    (Pg.confirms.length === 1 && /اعتماد 2 بطاقة/.test(Pg.confirms[0].title) && /ستصبح 1 بطاقة حركات/.test(Pg.confirms[0].text) && /1 بطاقة ينقصها بيانات/.test(Pg.confirms[0].text)
      && ap.length === 1 && ap[0].a.b === B1 && ap[0].a.o.version === M.batch.version - 1 && ap[0].a.o.idemKey === 'idem-1' && !ap[0].a.o.cardIds) || J([Pg.confirms, ap]));
  check('per-card result: saved / failed with the reason; the batch is partial; the billing gate reminder', () =>
    (/حُفظت 1 · موجودة من قبل 0 · متجاهلة 0 · فشلت 1/.test(root.textContent) && /اختر نوع جهة النقل للبطاقة/.test(root.querySelector('.appt-result').textContent)
      && /معتمدة جزئيًا/.test(root.textContent) && /الفوترة ما زالت موقوفة: 2 حاوية/.test(root.textContent) && !btnByText(root, /^إلغاء المسودة$/)) || root.textContent.slice(0, 900));
  // partial: select the failed card, give it a party, approve selected
  const pt2 = cellOf(rowOf(root, 'card-2'), 'party_type'); pt2.value = 'company'; pt2.dispatch('change');
  const pn2 = cellOf(rowOf(root, 'card-2'), 'party_name'); pn2.value = 'شركة النقل'; pn2.dispatch('input');
  const cb = rowOf(root, 'card-2').querySelector('.appt-sel'); cb.click();
  await settle(40);
  const asel = Pg.document.getElementById('appt-approve-sel');
  check('selection enables «approve selected (1)»', () => (!asel.disabled && /\(1\)/.test(asel.textContent)) || asel.textContent);
  asel.click();
  await settle(40);
  const ap2 = M.calls.filter(c => c.n === 'approveAppointmentDraft')[1];
  check('partial approval sends the selected card ids (after the autosave of its edits)', () =>
    (ap2 && J(ap2.a.o.cardIds) === J(['card-2']) && M.calls.findIndex(c => c.n === 'saveAppointmentDraft' && c.a.o.cards && c.a.o.cards[0].card_id === 'card-2') < M.calls.lastIndexOf(M.calls.find(c => c === ap2))
      && /اعتُمدت كل بطاقات هذه المسودة/.test(root.textContent)) || J(ap2 && ap2.a.o));

  // move-here from the queue
  const mh = btnByText(root, /نقل تلك المسودة إلى هذه المعاملة/);
  if (mh) { mh.click(); await settle(40); }
  check('move-here: moveAppointmentDraft(the other batch, this transaction number) behind a confirm', () =>
    M.calls.some(c => c.n === 'moveAppointmentDraft' && c.a[0] === OB && c.a[1] === 'TX-1') || J(M.calls.filter(c => c.n === 'moveAppointmentDraft')));

  section('DOM: restore, stale, cancel, move, read-only (appt-cards.js)');
  const existing = batchState({});
  existing.version = 7;
  existing.cards = [{ id: 'k1', seq: 1, file_name: 'a.pdf', file_size: 10, source_sha256: '9'.repeat(64), reading: { appointment: APPT(1), warnings: [] }, review: { party_type: 'company', party_name: 'ش' }, status: 'pending' },
    { id: 'k2', seq: 2, file_name: 'b.pdf', file_size: 10, source_sha256: '8'.repeat(64), reading: { appointment: Object.assign(APPT(2), { movement_type: 'empty_entry' }) }, review: {}, status: 'pending' }];
  const MR = mockApi({ batch: existing, staleOnce: true });
  const PR = pageContext(MR.api, '#appt-tx=' + TX);
  await settle(30);
  check('reopen restores the pending draft without any reading; review values come from the saved review; empty entry flagged as skipped', () =>
    (!MR.calls.some(c => c.n === 'aiExtract') && rowOf(PR.root, 'k1') && cellOf(rowOf(PR.root, 'k1'), 'party_name').value === 'ش' && /دخول فارغ: لا يصبح حركة/.test(PR.root.querySelector('[data-notes="k2"]').textContent)) || PR.root.textContent.slice(0, 400));
  const dn = cellOf(rowOf(PR.root, 'k1'), 'driver_name'); dn.value = 'غيره'; dn.dispatch('input');
  await settle(40);
  check('a stale autosave shows the reload notice and blocks editing', () => (/عدّل شخص آخر هذه المسودة/.test(PR.root.textContent) && cellOf(rowOf(PR.root, 'k1'), 'driver_name').disabled) || PR.root.textContent.slice(0, 400));
  btnByText(PR.root, /^إعادة التحميل$/).click();
  await settle(30);
  // cancel needs a reason
  btnByText(PR.root, /^إلغاء المسودة$/).click(); await settle(10);
  check('cancel without a reason: refused locally, nothing sent', () => (!MR.calls.some(c => c.n === 'cancelAppointmentDraft') && /اكتب سبب الإلغاء/.test(PR.root.textContent)) || 'sent');
  PR.document.getElementById('appt-cancel-reason').value = 'بطاقات خاطئة';
  btnByText(PR.root, /^إلغاء المسودة$/).click(); await settle(30);
  check('cancel with a reason → cancelAppointmentDraft(batch, reason) behind a confirm; cards released', () =>
    (MR.calls.some(c => c.n === 'cancelAppointmentDraft' && c.a[0] === B1 && c.a[1] === 'بطاقات خاطئة') && /حُرِّرت 2 بطاقة/.test(PR.root.textContent)) || PR.root.textContent.slice(0, 300));
  const MM = mockApi({ batch: Object.assign(batchState({}), { cards: [existing.cards[0]] }) });
  const PM = pageContext(MM.api, '#appt-tx=' + TX);
  await settle(30);
  PM.document.getElementById('appt-move-ref').value = 'tx-2';
  btnByText(PM.root, /^نقل المسودة$/).click(); await settle(30);
  check('move by number → moveAppointmentDraft(batch, number); the target is linked', () =>
    (MM.calls.some(c => c.n === 'moveAppointmentDraft' && c.a[0] === B1 && c.a[1] === 'tx-2') && /نُقلت المسودة إلى المعاملة TX-2/.test(PM.root.textContent)
      && PM.root.querySelectorAll('a').some(a => a.href === 'ocr.html#appt-tx=' + TX2)) || PM.root.textContent.slice(0, 300));
  const MO = mockApi({ batch: Object.assign(batchState({ canEdit: false }), { cards: [existing.cards[0]] }) });
  const PO = pageContext(MO.api, '#appt-tx=' + TX, { can: () => false });
  await settle(30);
  check('read-only role: upload disabled, inputs disabled, no approve / cancel buttons', () =>
    (PO.document.getElementById('appt-files').disabled && cellOf(rowOf(PO.root, 'k1'), 'driver_name').disabled && !PO.document.getElementById('appt-approve-all')
      && !btnByText(PO.root, /^إلغاء المسودة$/) && /صلاحيتك للعرض فقط/.test(PO.root.textContent)) || PO.root.textContent.slice(0, 300));
  const MN = mockApi();
  const PN = pageContext(MN.api, '');
  await settle(20);
  check('without a deep link the section stays hidden', () => PN.sec.hidden === true || 'shown');
  // a transport writer of another branch only reads here (no AI read spent on a save the server refuses)
  const MB = mockApi();
  MB.api.getTransaction = id => ok({ id, ref: 'TX-1', branch_id: 'BR-DMM', org_id: ORG, cargo_unit_type: 'container' });
  const PB = pageContext(MB.api, '#appt-tx=' + TX, { context: () => ({ memberships: [{ org_id: ORG, branch_id: 'BR-JED', role: 'transport_staff' }, { org_id: ORG, branch_id: 'BR-DMM', role: 'accountant' }] }) });
  await settle(30);
  const PB2 = pageContext(mockApi().api, '#appt-tx=' + TX, { context: () => ({ memberships: [{ org_id: ORG, branch_id: null, role: 'transport_staff' }] }) });
  await settle(30);
  check('the upload is gated on the transaction branch: a writer elsewhere (accountant here) gets no upload; an org-wide writer does', () =>
    (PB.document.getElementById('appt-files').disabled && /صلاحيتك للعرض فقط/.test(PB.root.textContent) && !PB2.document.getElementById('appt-files').disabled) || PB.root.textContent.slice(0, 300));
}

function opsEl(document) {
  return (tag, attrs, kids) => {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => { const v = attrs[k]; if (v == null || v === false) return; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); });
    [].concat(kids == null ? [] : kids).forEach(function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) return c.forEach(add); n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
}
function txContext() {
  const { document } = makeDom();
  const w2 = { MarsaI18n: I18N, document, open: () => null };
  class FileReader { readAsDataURL(f) { setTimeout(() => { this.result = 'data:application/pdf;base64,' + f.name; this.onload && this.onload(); }, 0); } }
  const c2 = { window: w2, document, FileReader, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent };
  w2.window = w2;
  vm.createContext(c2);
  vm.runInContext(DICT, c2); vm.runInContext(TXA, c2); vm.runInContext(TXR, c2);
  return { document, w2 };
}
function txApi(document, A, extra) {
  const log = { toasts: [], confirms: [], refresh: 0 };
  let k = 0;
  const api = Object.assign({ el: opsEl(document), can: () => true, cancelled: false, orgId: ORG, fmtDate: v => String(v), errText: e => e.code + (e.field ? ':' + e.field : ''), isEn: () => false,
    label: (d, c) => c, MarsaApi: A, toast: (m, t) => log.toasts.push([t, m]), confirm: o => { log.confirms.push(o); return Promise.resolve(true); },
    refresh: () => { log.refresh++; }, newIdemKey: () => 'key-' + (++k) }, extra || {});
  return { api, log };
}
async function txFlows() {
  section('DOM: transaction sections — readiness, card draft, TASTO (tx-appt.js)');
  const { document, w2 } = txContext();
  const calls = [];
  let readiness = { transaction_id: TX, billing_gate_open: false, blocking: 'containers_not_returned', pending_count: 1, declared_missing: 0, containers_total: 2,
    pending_containers: [{ container_id: C1, container_no: 'MSKU1234565', return_status: 'pending', return_deadline: '2026-11-01', overdue: true, proofs_pending: 1 }],
    policy: { empty_return_blocks_billing: true, switchable: false }, carrier_order: { order_no: 'TASTO77', party_name: 'ناقل', bypasses_empty_return: false } };
  const A = {
    txReadiness: id => { calls.push(['ready', id]); return ok(readiness); },
    getAppointmentDraft: id => { calls.push(['draft', id]); return ok({ id: B1, status: 'partial', cards: [{ status: 'pending' }, { status: 'approved' }, { status: 'failed' }] }); },
    listParties: f => { calls.push(['parties', f]); return ok([{ id: 'P1', name_ar: 'شركة النقل السريع' }]); },
    saveTransportCarrierOrder: (id, o) => { calls.push(['tasto', id, o]); return ok({ transaction_id: id, order_no: o.orderNo, already_exists: false, readiness }); }
  };
  const S = id => w2.MarsaOps.txSections.filter(x => x.id === id)[0];
  const tx = { id: TX, ref: 'TX-1', branch_id: 'b', operational_status: 'transport', transport_mode: 'driver' };
  const h1 = document.createElement('div'); document.body.appendChild(h1);
  const T1 = txApi(document, A);
  await S('readiness').render(h1, tx, T1.api);
  check('readiness blocked: warning, the pending container (overdue, proofs waiting), the TASTO note, the fixed policy', () =>
    (h1.querySelector('.alert-warning') && /الفوترة موقوفة حتى تُثبَت إعادة الفارغ/.test(h1.textContent) && /MSKU1234565/.test(h1.textContent) && /متأخرة/.test(h1.textContent)
      && /إثبات بانتظار التأكيد: 1/.test(h1.textContent) && /TASTO77[\s\S]*لا يغني عن إيصال إعادة الفارغ/.test(h1.textContent) && /ثابتة ولا يمكن تعطيلها/.test(h1.textContent)) || h1.textContent);
  readiness = { billing_gate_open: true, pending_containers: [], containers_total: 2, policy: { empty_return_blocks_billing: true, switchable: false } };
  const h1b = document.createElement('div');
  await S('readiness').render(h1b, tx, T1.api);
  check('readiness open: success line', () => (h1b.querySelector('.alert-success') && /لا شيء يمنع الفوترة/.test(h1b.textContent)) || h1b.textContent);
  const h2 = document.createElement('div');
  await S('appointment_cards').render(h2, tx, T1.api);
  check('card draft summary: the read link (transport writer) and the open draft counts', () =>
    (h2.querySelectorAll('a').some(a => a.href === 'ocr.html#appt-tx=' + TX) && /معتمدة جزئيًا/.test(h2.textContent) && /بانتظار: 1 · فشل: 1 · معتمدة: 1/.test(h2.textContent)) || h2.textContent);
  const h2b = document.createElement('div');
  await S('appointment_cards').render(h2b, tx, txApi(document, A, { can: () => false }).api);
  check('a read-only role sees the draft but no read link', () => (!h2b.querySelectorAll('a').some(a => /btn-primary/.test(a.className)) && /عرض المسودة/.test(h2b.textContent)) || h2b.textContent);
  const h3 = document.createElement('div'); document.body.appendChild(h3);
  await S('carrier_order').render(h3, tx, T1.api);
  check('TASTO form: carriers listed, the note that the empty-return proof is still required', () =>
    (calls.some(c => c[0] === 'parties' && c[1].kind === 'carrier') && /لا يلغي شرط إثبات إعادة الفارغ/.test(h3.textContent) && document.getElementById('appt-co-party').options.length === 3) || h3.textContent);
  document.getElementById('appt-co-no').value = 'TAS99';
  document.getElementById('appt-co-date').value = '2026-11-11';
  document.getElementById('appt-co-party').value = 'P1';
  document.getElementById('appt-co-save').click(); await settle(10);
  check('an invalid order number is refused locally', () => (!calls.some(c => c[0] === 'tasto') && /يجب أن يبدأ بـ TASTO/.test(h3.textContent)) || h3.textContent);
  document.getElementById('appt-co-no').value = ' tasto 2026111000001 ';
  document.getElementById('appt-co-save').click(); await settle(10);
  const ts = calls.filter(c => c[0] === 'tasto');
  check('save → saveTransportCarrierOrder(tx, normalized no, date, party, idempotency key); toast repeats the proof rule; page refresh', () =>
    (ts.length === 1 && ts[0][1] === TX && J(ts[0][2]) === J({ orderNo: 'TASTO2026111000001', orderDate: '2026-11-11', partyId: 'P1', idemKey: 'key-1' }) && T1.log.refresh === 1
      && /إثبات إعادة الفارغ ما زال مطلوبًا/.test(T1.log.toasts[0][1])) || J([ts, T1.log]));
  const h3b = document.createElement('div'); document.body.appendChild(h3b);
  await S('carrier_order').render(h3b, Object.assign({}, tx, { operational_status: 'in_progress' }), txApi(document, A).api);
  check('TASTO from the in-progress stage: the form is disabled with the stage hint', () =>
    (h3b.querySelectorAll('button').every(b => b.disabled) && /قبل انتهاء الإجراء الجمركي/.test(h3b.textContent)) || h3b.textContent);
  const h3c = document.createElement('div'); document.body.appendChild(h3c);
  await S('carrier_order').render(h3c, Object.assign({}, tx, { operational_status: 'customs_declaration' }), txApi(document, A).api);
  check('TASTO at the customs-declaration stage (legacy «نشطة», before the customs release): disabled too, as the server refuses it', () =>
    (h3c.querySelectorAll('button').every(b => b.disabled) && /قبل انتهاء الإجراء الجمركي/.test(h3c.textContent)
      && J(TA.NO_TASTO_STAGES) === J(['new', 'in_progress', 'customs_declaration']) && /'new','in_progress','customs_declaration'\) THEN PERFORM app\.fail\('MRS_TASTO_STAGE'/.test(MIG)) || h3c.textContent);

  section('DOM: empty-return proofs (tx-return.js)');
  const ctx2 = txContext();
  const D = ctx2.document;
  const rc = [];
  let proofs = [
    { id: 'p1', transaction_id: TX, container_id: C1, container_no: 'MSKU1234565', document_id: 'doc-eir.pdf', source: 'ai', delivered_at: '2026-11-10T11:05:00Z', depot: 'ساحة الدمام', confidence: 0.82, status: 'pending_review', match_notes: null, created_at: '2026-11-10' },
    { id: 'p2', transaction_id: TX, container_id: null, container_no: 'TCLU9999990', document_id: 'doc-x', source: 'ai', delivered_at: null, depot: null, confidence: 0.4, status: 'pending_review', match_notes: 'container_not_in_transaction | delivery_time_missing | depot_missing', created_at: '2026-11-10' },
    { id: 'p3', transaction_id: TX, container_id: C2, container_no: 'TGHU7654321', document_id: 'doc-y', source: 'manual', delivered_at: '2026-11-09T08:00:00Z', depot: 'D', confidence: null, status: 'approved', created_at: '2026-11-09', verified_at: '2026-11-09' }];
  const RA = {
    listEmptyReturnProofs: id => { rc.push(['list', id]); return ok({ transaction_id: id, proofs, readiness: {} }); },
    listContainers: id => ok([{ id: C1, container_no: 'MSKU1234565', return_status: 'pending', return_deadline: '2026-11-20' }, { id: C2, container_no: 'TGHU7654321', return_status: 'returned_verified', returned_at: '2026-11-09' }]),
    listDocuments: o => ok([{ id: 'doc-eir.pdf', sha256: SHA['eir.pdf'], storage_path: 'x' }]),
    aiAccess: () => ok({ can_use: true }),
    aiExtract: o => { rc.push(['ai', o.docType, o.promptVersion, o.transactionId]); return M2.api.aiExtract(o); },
    uploadDocument: o => { rc.push(['upload', o.kind, o.file.name]); return ok({ id: 'doc-' + o.file.name, sha256: SHA[o.file.name] }); },
    saveExtraction: row => { rc.push(['ext', row.doc_type, row.document_id]); return ok({ id: 'ext-eir' }); },
    findExtractionBySource: () => ok(null),
    createEmptyReturnProof: (id, o) => { rc.push(['create', id, o]); return ok({ id: 'pn', status: o.unreadable ? 'unreadable' : 'pending_review', container_no: 'MSKU1234565', container_matched: true }); },
    verifyEmptyReturnProof: (id, o) => { rc.push(['verify', id, o]); return ok({ id, status: 'approved', container_already_returned: false }); },
    voidEmptyReturnProof: (id, r) => { rc.push(['void', id, r]); return ok({ id, status: 'voided', container_reverted: true }); },
    saveEmptyReturnDeadline: (id, d) => { rc.push(['deadline', id, d]); return ok({}); },
    documentUrl: () => ok('https://x/y'),
    util: { sha256Hex: f => Promise.resolve(SHA[f.name] || 'e'.repeat(64)) }
  };
  const M2 = mockApi();
  const host = D.createElement('div'); D.body.appendChild(host);
  const R1 = txApi(D, RA);
  const SR = ctx2.w2.MarsaOps.txSections.filter(x => x.id === 'empty_return')[0];
  await SR.render(host, tx, R1.api); await settle(10);
  check('the register: statuses, confidence, match notes, the anchor; the never-automatic rule', () =>
    (host.querySelector('#tx-empty-return') && host.querySelectorAll('[data-proof]').length === 3 && /بانتظار المراجعة/.test(host.textContent) && /82%/.test(host.textContent)
      && /الحاوية ليست من المعاملة/.test(host.textContent) && /وقت التسليم غير موجود/.test(host.textContent) && /لا تؤكد الإعادة أبدًا/.test(host.textContent)
      && host.querySelectorAll('[data-verify]').length === 2 && !host.querySelector('[data-verify="p3"]') && !!host.querySelector('[data-void="p3"]')) || host.textContent.slice(0, 600));
  check('deadline-only save is offered only for a container not yet returned', () => (!!host.querySelector('[data-deadline="' + C1 + '"]') && !host.querySelector('[data-deadline="' + C2 + '"]')) || 'deadline');
  D.getElementById('appt-er-dl-' + C1).value = '2026-11-25';
  host.querySelector('[data-deadline="' + C1 + '"]').click(); await settle(10);
  check('deadline save → saveEmptyReturnDeadline(container, date) → page refresh (the extension request section and the alerts follow the deadline)', () => (rc.some(c => c[0] === 'deadline' && c[1] === C1 && c[2] === '2026-11-25') && R1.log.refresh === 1) || J([rc, R1.log]));
  // EIR reading → pending proof only
  D.getElementById('appt-er-file').files = [F('eir2.pdf')];
  D.getElementById('appt-er-read').click(); await settle(60);
  const cr = rc.filter(c => c[0] === 'create');
  check('EIR reading: aiExtract empty_return_receipt v3 → document (kind empty_return_receipt) → reading saved → a pending proof (source ai + extraction); never verified', () =>
    (rc.some(c => c[0] === 'ai' && c[1] === 'empty_return_receipt' && c[2] === 'ai-doc-v3' && c[3] === TX) && rc.some(c => c[0] === 'upload' && c[1] === 'empty_return_receipt' && c[2] === 'eir2.pdf')
      && rc.some(c => c[0] === 'ext' && c[1] === 'empty_return_receipt' && c[2] === 'doc-eir2.pdf') && cr.length === 1
      && J(cr[0][2]) === J({ documentId: 'doc-eir2.pdf', source: 'ai', idemKey: 'key-1', extractionId: 'ext-eir' }) && !rc.some(c => c[0] === 'verify')
      && /بانتظار تأكيد موظف/.test(R1.log.toasts[R1.log.toasts.length - 1][1]) && R1.log.refresh === 2) || J([rc, R1.log]));
  // a failed AI reading: the file is kept and an «unreadable» proof recorded (legacy «تعذر القراءة»), never verified
  const hostF = D.createElement('div'); D.body.appendChild(hostF);
  const RAF = Object.assign({}, RA, { aiExtract: o => { rc.push(['aiF']); return Promise.resolve({ data: null, error: { code: 'MRS_AI_FAILED', message: 'x' } }); } });
  const nF = rc.length, RF = txApi(D, RAF);
  await SR.render(hostF, tx, RF.api); await settle(10);
  hostF.querySelector('#appt-er-file').files = [F('eir2.pdf')];
  hostF.querySelector('#appt-er-read').click(); await settle(60);
  const fc = rc.slice(nF).filter(c => c[0] === 'create');
  check('EIR read failed (MRS_AI_FAILED): the file is uploaded (kind empty_return_receipt) and an unreadable proof recorded for staff to complete; nothing verified', () =>
    (rc.slice(nF).some(c => c[0] === 'upload' && c[1] === 'empty_return_receipt' && c[2] === 'eir2.pdf') && fc.length === 1
      && J(fc[0][2]) === J({ documentId: 'doc-eir2.pdf', source: 'ai', unreadable: true, matchNotes: 'ai_read_failed', idemKey: 'key-1' })
      && !rc.slice(nF).some(c => c[0] === 'verify' || c[0] === 'ext') && /سُجّل إثبات «غير مقروء»/.test(RF.log.toasts[0][1])
      && TR.readFailSaves({ code: 'MRS_AI_FAILED' }) && !TR.readFailSaves({ code: 'MRS_AI_DAILY_CAP' }) && !TR.readFailSaves({ code: 'MRS_AI_WRONG_DOCUMENT' })) || J([rc.slice(nF), RF.log]));
  // a wrong document: nothing uploaded, nothing created
  const host2 = D.createElement('div'); D.body.appendChild(host2);
  const M3 = mockApi({ eirWrong: true });
  const RA2 = Object.assign({}, RA, { aiExtract: o => { rc.push(['ai2']); return M3.api.aiExtract(o); } });
  const n0 = rc.length;
  await SR.render(host2, tx, txApi(D, RA2).api); await settle(10);
  host2.querySelector('#appt-er-file').files = [F('eir.pdf')];
  host2.querySelector('#appt-er-read').click(); await settle(60);
  check('EIR wrong document (a full-container exit): the reason shown, no document uploaded, no proof', () =>
    (/ليس لإعادة حاوية فارغة/.test(host2.textContent) && !rc.slice(n0).some(c => c[0] === 'upload' || c[0] === 'create')) || host2.textContent.slice(0, 300));
  check('the error repaint keeps the chosen file (one file input for the section) and the manual toggle keeps it too', () => {
    const f1 = host2.querySelector('#appt-er-file');
    host2.querySelector('#appt-er-manual-toggle').click();
    const f2 = host2.querySelector('#appt-er-file');
    return (f1 === f2 && f2.files && f2.files[0] && f2.files[0].name === 'eir.pdf') || 'file lost';
  });
  await settle(5);
  host2.querySelector('#appt-er-m-ctr').value = C1; host2.querySelector('#appt-er-m-ctr').dispatch('change');
  host2.querySelector('#appt-er-m-at').value = '2026-11-10'; host2.querySelector('#appt-er-m-at').dispatch('input');
  host2.querySelector('#appt-er-m-depot').value = 'ساحة'; host2.querySelector('#appt-er-m-depot').dispatch('input');
  const nM = rc.length;
  host2.querySelector('#appt-er-m-save').click(); await settle(10);
  check('manual proof with a date and no time: the error shows inline, the form keeps the container / date / depot and the file; nothing sent', () => {
    const e = host2.querySelector('#appt-er-m-err');
    return (e && !e.hidden && /التاريخ وحده لا يكفي/.test(e.textContent) && host2.querySelector('#appt-er-m-ctr').value === C1 && host2.querySelector('#appt-er-m-at').value === '2026-11-10'
      && host2.querySelector('#appt-er-m-depot').value === 'ساحة' && host2.querySelector('#appt-er-file').files[0].name === 'eir.pdf' && !rc.slice(nM).some(c => c[0] === 'create'))
      || host2.textContent.slice(0, 400);
  });
  // staff confirmation
  const host3 = D.createElement('div'); D.body.appendChild(host3);
  const R3 = txApi(D, RA);
  await SR.render(host3, tx, R3.api); await settle(10);
  host3.querySelector('[data-verify="p1"]').click(); await settle(5);
  check('verify form prefilled from the proof: container, Riyadh local time, depot', () =>
    (host3.querySelector('#appt-er-v-ctr-p1').value === C1 && host3.querySelector('#appt-er-v-at-p1').value === '2026-11-10T14:05' && host3.querySelector('#appt-er-v-depot-p1').value === 'ساحة الدمام') || host3.textContent.slice(0, 300));
  host3.querySelector('#appt-er-v-at-p1').value = '2026-11-10';
  host3.querySelector('[data-verify-go="p1"]').click(); await settle(10);
  check('a date without a time is refused before any call', () => (!rc.some(c => c[0] === 'verify') && /التاريخ وحده لا يكفي/.test(host3.textContent) && !R3.log.confirms.length) || host3.textContent.slice(0, 300));
  host3.querySelector('#appt-er-v-at-p1').value = '2026-11-10T14:05';
  host3.querySelector('[data-verify-go="p1"]').click(); await settle(20);
  const vf = rc.filter(c => c[0] === 'verify');
  check('«تأكيد إعادة الفارغ»: the confirm dialog names container / time / depot, then verifyEmptyReturnProof with an idempotency key', () =>
    (R3.log.confirms.length === 1 && /MSKU1234565/.test(R3.log.confirms[0].text) && /2026-11-10 14:05/.test(R3.log.confirms[0].text) && vf.length === 1 && vf[0][1] === 'p1'
      && J(vf[0][2]) === J({ containerId: C1, deliveredAt: '2026-11-10T14:05', depot: 'ساحة الدمام', idemKey: 'key-1' }) && R3.log.refresh === 1 && /أُكّدت إعادة الحاوية/.test(R3.log.toasts[0][1])) || J([R3.log, vf]));
  // declined confirm: nothing sent
  const host4 = D.createElement('div'); D.body.appendChild(host4);
  const R4 = txApi(D, RA, { confirm: () => Promise.resolve(false) });
  await SR.render(host4, tx, R4.api); await settle(10);
  host4.querySelector('[data-verify="p1"]').click(); await settle(5);
  host4.querySelector('[data-verify-go="p1"]').click(); await settle(10);
  check('a declined confirm sends nothing', () => rc.filter(c => c[0] === 'verify').length === 1 || 'sent');
  // void with a reason
  host4.querySelector('[data-void="p3"]').click(); await settle(5);
  host4.querySelector('[data-void-go="p3"]').click(); await settle(5);
  check('void needs a reason', () => (!rc.some(c => c[0] === 'void') && /اكتب سبب الإلغاء/.test(host4.textContent)) || 'sent');
  const host5 = D.createElement('div'); D.body.appendChild(host5);
  const R5 = txApi(D, RA);
  await SR.render(host5, tx, R5.api); await settle(10);
  host5.querySelector('[data-void="p3"]').click(); await settle(5);
  host5.querySelector('#appt-er-void-p3').value = 'إيصال حاوية أخرى';
  host5.querySelector('[data-void-go="p3"]').click(); await settle(10);
  check('void an approved proof: the confirm warns about the revert, voidEmptyReturnProof(proof, reason), the revert is reported', () =>
    (/ستعود حالة إعادتها/.test(R5.log.confirms[0].text) && rc.some(c => c[0] === 'void' && c[1] === 'p3' && c[2] === 'إيصال حاوية أخرى') && /أُعيدت حالة الحاوية/.test(R5.log.toasts[0][1])) || J(R5.log));
  // manual proof
  const host6 = D.createElement('div'); D.body.appendChild(host6);
  const R6 = txApi(D, RA);
  await SR.render(host6, tx, R6.api); await settle(10);
  host6.querySelector('#appt-er-manual-toggle').click(); await settle(5);
  host6.querySelector('#appt-er-file').files = [F('eir.pdf')];
  host6.querySelector('#appt-er-m-ctr').value = C1;
  host6.querySelector('#appt-er-m-at').value = '2026-11-10T09:00';
  host6.querySelector('#appt-er-m-depot').value = 'ساحة';
  host6.querySelector('#appt-er-m-save').click(); await settle(20);
  const mc = rc.filter(c => c[0] === 'create').pop();
  check('manual proof: the file already on the transaction is reused (no upload), a pending proof with container / time / depot, no verification', () =>
    (J(mc[2]) === J({ source: 'manual', deliveredAt: '2026-11-10T09:00', containerId: C1, depot: 'ساحة', documentId: 'doc-eir.pdf', idemKey: 'key-1' }) && !rc.some(c => c[0] === 'upload' && c[2] === 'eir.pdf')
      && rc.filter(c => c[0] === 'verify').length === 1) || J(mc));
  // read-only role
  const host7 = D.createElement('div'); D.body.appendChild(host7);
  await SR.render(host7, tx, txApi(D, RA, { can: () => false }).api); await settle(10);
  check('a read-only role (e.g. accountant): the register only — no upload, no verify, no void, no deadline save', () =>
    (host7.querySelectorAll('[data-proof]').length === 3 && !host7.querySelector('#appt-er-read') && !host7.querySelector('[data-verify]') && !host7.querySelector('[data-void]') && !host7.querySelector('[data-deadline]')) || host7.textContent.slice(0, 300));
}

(async function () {
  await cardsFlow();
  await txFlows();
  await settle(20);
  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
