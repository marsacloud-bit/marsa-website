#!/usr/bin/env node
/*
  Marsa (مرسى) — owner stage 3أ (2026-11-20): a new transaction starts by reading its documents (ocr.html#new-tx).
  LOCAL TESTS ONLY. No database, no network.

  Covers: «معاملة جديدة بالقراءة» in «المعاملات» links to ocr.html#new-tx (the manual form stays as «إدخال يدوي»);
  routeHash takes #new-tx first and leaves the mode on any other hash; signed-out / non-staff → no mode; the client is
  chosen before reading (the read button stays disabled without it); the declaration slot and the link-to-a-transaction
  form step aside; the declaration step is shown disabled; the draft panel opens by itself with the chosen client and no
  picker; the importer-name check (ntMatchState: ok / near / none / other / noname / pending) and the confirmation it
  needs before the draft is made; labels in Arabic and English; CSS; sw VERSION.

  usage:
    node supabase/tests/new-tx-reading-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
const J = x => JSON.stringify(x);
function check(name, fn) {
  try { const r = fn(); if (typeof r === 'string') fail(name, r); else if (!r) fail(name, 'assertion false'); else pass(name); }
  catch (e) { fail(name, 'threw: ' + (e && e.stack || e)); }
}

const M = rd('assets/js/ocr-match.js');
const REG = rd('assets/js/rpt/register.js');
const fnBody = name => { const a = M.indexOf('function ' + name + '('); if (a < 0) return ''; const b = M.indexOf('\n    }\n', a); return M.slice(a, b); };

check('register: «معاملة جديدة بالقراءة» is the primary link to ocr.html#new-tx; the manual form is a ghost «إدخال يدوي»', () =>
  /href: 'ocr\.html#new-tx', 'data-act': 'new-tx-read'/.test(REG) && /btn btn-sm btn-primary', href: 'ocr\.html#new-tx'/.test(REG)
  && /U\.btn\(lt\('new_tx_manual'\), 'btn-ghost'/.test(REG) || 'buttons');

const route = fnBody('routeHash');
check('routeHash: #new-tx first (opens the mode), any other hash leaves it', () =>
  route.indexOf("/^#new-tx$/i") > 0 && route.indexOf('openNewTx()') > 0 && route.indexOf('if (NT) closeNewTx();') > route.indexOf('openNewTx()')
  && route.indexOf('openNewTx()') < route.indexOf('parseMatchId') || route);

const open = fnBody('openNewTx');
check('openNewTx: only for signed-in staff; hides the other sections, the declaration slot, the link-to-a-transaction form and the save button', () =>
  /if \(!\(ONLINE && STAFF\)\) return;/.test(open) && /main > section\.section/.test(open) && /\[data-slot="declaration"\]/.test(open)
  && /#ocr-match-save \.ocr-save-form/.test(open) && /ocr-match-save-btn/.test(open) && /T\('nt_title'\)/.test(open) || open);
check('closeNewTx: everything hidden by the mode comes back, the page title too', () =>
  /NT\.hidden\.forEach\(function \(n\) \{ n\.hidden = false; \}\)/.test(fnBody('closeNewTx')) && /NT\.h1/.test(fnBody('closeNewTx')) || 'restore');

check('syncRun: the read button needs the chosen client in the mode', () => /\(!NT \|\| !!NT\.clientId\)/.test(fnBody('syncRun')) || 'gate');
check('syncGate: the section shows for staff in the mode even when AI reading is off (the box explains it)', () =>
  /ONLINE && STAFF && \(AI\.enabled \|\| !!NT\)/.test(fnBody('syncGate')) && /nt_ai_off/.test(fnBody('renderNewTx')) || 'gate');

const rn = fnBody('renderNewTx');
check('renderNewTx: four steps — the client (search + list from listClients), the documents, the declaration and the appointment card disabled', () =>
  /ntStep\(1, T\('nt_step_client'\)/.test(rn) && /ntStep\(2, T\('nt_step_docs'\)/.test(rn) && /ntStep\(3, T\('nt_step_decl'\), 'locked'/.test(rn)
  && /b3\.disabled = true/.test(rn) && /API\.listClients\(/.test(rn)
  && /ntStep\(4, T\('nt_step_appt'\), 'locked'/.test(rn) && /b4\.disabled = true/.test(rn) && /T\('nt_step_appt_storage'\)/.test(rn) || 'steps');
check('renderNewTx: changing the client after a reading resets the draft panel (match, confirmation, client)', () =>
  /S\.draft\.match = null; S\.draft\.matchFailed = false; S\.draft\.open = false; S\.draft\.autoOpened = false; S\.draft\.confirmClient = false;/.test(rn) || 'reset');

check('openDraft: the chosen client is the draft client', () =>
  /if \(NT && NT\.clientId\) \{ D\.clientSel = NT\.clientId; D\.clientId = NT\.clientId; \}/.test(fnBody('openDraft')) || 'client');
const rdp = fnBody('renderDraftPanel');
check('renderDraftPanel: opens by itself once in the mode; the picker hidden; the confirmation only when the name is not this client\'s', () =>
  /draftState\(\)\.autoOpened = true; openDraft\(\); return;/.test(rdp) && /ntClientBlock\(form, D\)/.test(rdp)
  && /csWrap\.hidden = true; nameWrap\.hidden = true; cc\.hidden = ntMatchState\(D\) === 'ok';/.test(rdp) || 'panel');
check('confirmDraft: a name not matching the chosen client needs the confirmation (nt_need_confirm)', () =>
  /if \(NT && ntMatchState\(D\) !== 'ok' && !D\.confirmClient\) \{ D\.error = T\('nt_need_confirm'\);/.test(fnBody('confirmDraft')) || 'confirm');

// ntMatchState in a sandbox
const src = fnBody('ntMatchState') + '\n    }';
const box = { NT: null };
vm.createContext(box);
vm.runInContext(src + '\nthis.f = ntMatchState;', box);
const C1 = 'c1', C2 = 'c2';
const st = (nt, d) => { box.NT = nt; return box.f(d); };
check('ntMatchState: outside the mode → ok', () => st(null, {}) === 'ok');
check('ntMatchState: no importer name read → noname', () => st({ clientId: C1 }, { matchName: '' }) === 'noname');
check('ntMatchState: match not back yet → pending', () => st({ clientId: C1 }, { matchName: 'ACME' }) === 'pending');
check('ntMatchState: the importer check failed → failed (not an endless «pending»)', () => st({ clientId: C1 }, { matchName: 'ACME', matchFailed: true }) === 'failed');
check('ntMatchState: the name is this client\'s (preselect) → ok', () => st({ clientId: C1 }, { matchName: 'ACME', match: { preselect: C1, candidates: [{ client_id: C1 }] } }) === 'ok');
check('ntMatchState: the name is another client\'s → other', () => st({ clientId: C1 }, { matchName: 'ACME', match: { preselect: C2, candidates: [{ client_id: C2 }] } }) === 'other');
check('ntMatchState: close names include this client → near', () => st({ clientId: C1 }, { matchName: 'ACME', match: { preselect: null, candidates: [{ client_id: C1 }] } }) === 'near');
check('ntMatchState: not found at all → none', () => st({ clientId: C1 }, { matchName: 'ACME', match: { preselect: null, candidates: [] } }) === 'none');

// labels
const I = rd('assets/i18n/ocr.js'), L = rd('assets/i18n/lrpt.js');
const keys = ['nt_title', 'nt_lead', 'nt_ai_off', 'nt_step_client', 'nt_client_search', 'nt_client_label', 'nt_client_pick', 'nt_client_first', 'nt_step_docs',
  'nt_step_docs_hint', 'nt_step_docs_done', 'nt_step_decl', 'nt_step_decl_btn', 'nt_step_decl_hint', 'nt_step_appt', 'nt_step_appt_btn', 'nt_step_appt_hint', 'nt_step_appt_storage', 'nt_client_chosen', 'nt_match_ok', 'nt_match_near',
  'nt_match_none', 'nt_match_other', 'nt_match_noname', 'nt_match_pending', 'nt_match_failed', 'nt_need_confirm'];
check('i18n/ocr.js: every nt_* label in Arabic and English', () => {
  const miss = keys.filter(k => (I.match(new RegExp('\\b' + k + ': \'', 'g')) || []).length !== 2);
  return !miss.length || 'missing ' + J(miss);
});
check('i18n/lrpt.js: new_tx_read / new_tx_manual in Arabic and English', () =>
  /new_tx_read: 'معاملة جديدة بالقراءة', new_tx_manual: 'إدخال يدوي'/.test(L) && /new_tx_read: 'New transaction from documents', new_tx_manual: 'Manual entry'/.test(L) || 'labels');
check('ocr.css: the steps box styles (.ocr-nt, numbered circles, done / locked)', () => {
  const css = rd('assets/css/pages/ocr.css');
  return /\.ocr-nt \{/.test(css) && /\.ocr-nt-step\.is-done \.ocr-nt-num/.test(css) && /\.ocr-nt-step\.is-locked/.test(css) || 'css';
});
check('sw.js: VERSION comment names the owner stage 3 work', () => /VERSION = '[^']+';\s+\/\/ (owner: [^\n]*)?owner reorg/.test(rd('sw.js')) && /stage 3أ/.test(rd('sw.js')) || 'version');

// stage 3ب: the same steps continue on the draft card of the transaction page
const TDsrc = rd('assets/js/ops/tx-draft.js'), DE = rd('assets/i18n/decl.js');
check('tx-draft.js: the steps strip — client + documents done, the declaration the current step, the appointment card locked with the storage reminder', () =>
  /step\(1, 'txd_step_client', 'done'\)/.test(TDsrc) && /step\(2, 'txd_step_docs', 'done'\)/.test(TDsrc) && /step\(3, 'txd_step_decl', 'active'/.test(TDsrc)
  && /step\(4, 'txd_step_appt', 'locked', el\('span', \{ class: 'txd-step-remind'/.test(TDsrc) && /body\.appendChild\(stepsStrip\(el, v\)\)/.test(TDsrc) || 'strip');
check('i18n/decl.js: «قراءة البيان التحضيري» button + the step labels in Arabic and English', () =>
  /txd_upload: 'قراءة البيان التحضيري'/.test(DE) && /txd_upload: 'Read the preliminary declaration'/.test(DE)
  && ['txd_steps_label', 'txd_step_client', 'txd_step_docs', 'txd_step_decl', 'txd_step_appt', 'txd_step_state_done', 'txd_step_state_active', 'txd_step_state_locked',
    'txd_step_decl_hint_read', 'txd_step_decl_hint_match', 'txd_step_appt_storage'].every(k => DE.split('\n').filter(line => line.indexOf(k + ': \'') !== -1).length === 2) || 'labels');
check('ops.css: the steps strip styles', () => /\.txd-steps \{/.test(rd('assets/css/pages/ops.css')) && /\.txd-step-remind/.test(rd('assets/css/pages/ops.css')) || 'css');

console.log('');
if (nFail) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); process.exit(1); }
console.log('OK — ' + nPass + ' passed, 0 failed');
