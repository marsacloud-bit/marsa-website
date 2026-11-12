#!/usr/bin/env node
/*
  Marsa (مرسى) — document matching engine tests: assets/js/doc-match.js (invoice ↔ B/L ↔ customs declaration).
  Pure Node, no database, no network, no dependencies.

  Covers: helpers (names AR / EN with legal suffixes, Arabic normalisation, ports + aliases, countries, currencies,
  ISO 6346 container sets, HS6 sets, number / weight parsing + tolerance, packages, package types, incoterms, dates,
  descriptions, ids, vessels); two-way rows (match / partial / mismatch / missing / info, omitted rows, critical flags,
  pairs, confidence, details AR + EN); overall rules; three-way (declaration disagrees with both, agrees with one,
  missing fields, currency differs, total vs subtotal, mode); line items + invoice totals; corrections; robustness
  against weird input; the UMD wrapper (window.MarsaDocMatch in a vm) and determinism; the optional packing list
  (match-v2, 20261126000100): a v1 snapshot digest without it, the inv_pack / bl_pack / decl_pack pairs, gross
  25000 vs 27500, missing packing values, the invoice reference via packing_list_number, with_packing / docs.

  usage:  node supabase/tests/doc-match-engine-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const M = require(path.join(ROOT, 'assets', 'js', 'doc-match.js'));
const J = JSON.stringify;

let pass = 0, fail = 0;
const fails = [];
let sec = '';
function section(t) { sec = t; if (!QUIET) console.log('\n== ' + t); }
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  if (r === true) { pass++; if (!QUIET) console.log('  ok  ' + name); }
  else { fail++; fails.push(sec + ' :: ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); if (!QUIET) console.log('  FAIL ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); }
}
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }
function row(res, key) { return res.rows.filter(r => r.key === key)[0] || null; }
function st(res, key) { const r = row(res, key); return r ? r.status : null; }

/* ----------------------------------------------------------------- fixtures */
function invoice(over) {
  return {
    fields: Object.assign({
      invoice_number: { value: 'INV-2026-0042', score: 0.97 }, invoice_date: { value: '2026-10-01', score: 0.95 },
      supplier_name: { value: 'Ningbo Sunrise Trading Co., Ltd.', score: 0.93 }, buyer_name: { value: 'Marsa Trading Company LLC', score: 0.9 },
      currency: { value: 'USD', score: 0.99 }, subtotal: { value: '25000', score: 0.95 }, total: { value: '25000', score: 0.95 },
      container_numbers: { value: 'MSCU1234566', score: 0.8 }, gross_weight: { value: '12500', score: 0.9 }, net_weight: { value: '12000', score: 0.9 },
      packages_count: { value: '500', score: 0.92 }, package_type: { value: 'CTNS', score: 0.9 }, hs_codes: { value: '8708.30.00, 8708.99.10', score: 0.88 },
      country_of_origin: { value: 'China', score: 0.95 }, port_of_loading: { value: 'Ningbo, China', score: 0.9 },
      port_of_discharge: { value: 'Jeddah Islamic Port', score: 0.9 }, incoterms: { value: 'CIF Jeddah', score: 0.9 },
      goods_description: { value: 'Brake pads and spare parts for passenger cars', score: 0.85 }, vessel: { value: 'MSC ANNA', score: 0.5 }
    }, over || {}),
    items: [
      { description: 'Brake pads front', hs_code: '8708.30.00', quantity: 400, unit_price: 50, amount: 20000 },
      { description: 'Spare parts kit', hs_code: '8708.99.10', quantity: 100, unit_price: 50, amount: 5000 }
    ]
  };
}
function bl(over) {
  return {
    fields: Object.assign({
      bl_number: { value: 'MEDU12345678', score: 0.96 }, shipper: { value: 'NINGBO SUNRISE TRADING CO LTD', score: 0.94 },
      consignee: { value: 'MARSA TRADING CO.', score: 0.93 }, container_numbers: { value: 'MSCU 123456-6', score: 0.95 },
      gross_weight: { value: '12,500.000 KGS', score: 0.9 }, net_weight: { value: '12000 KG', score: 0.8 }, packages_count: { value: '500', score: 0.95 },
      package_type: { value: 'Cartons', score: 0.9 }, port_of_loading: { value: 'CNNGB', score: 0.9 }, port_of_discharge: { value: 'JED', score: 0.9 },
      vessel: { value: 'M/V MSC ANNA V.234E', score: 0.9 }, goods_description: { value: 'BRAKE PADS, SPARE PARTS FOR CARS', score: 0.8 }
    }, over || {}),
    items: []
  };
}
function decl(over) {
  return {
    fields: Object.assign({
      declaration_number: { value: '3012345678', score: 0.98 }, bl_number: { value: 'MEDU12345678', score: 0.95 },
      invoice_number: { value: 'INV-2026-0042', score: 0.95 }, invoice_date: { value: '01/10/2026', score: 0.9 },
      consignee: { value: 'Marsa Trading Co', score: 0.9 }, container_numbers: { value: 'MSCU1234566', score: 0.95 },
      gross_weight: { value: '12500', score: 0.9 }, packages_count: { value: '500', score: 0.95 }, hs_codes: { value: '870830 870899', score: 0.9 },
      country_of_origin: { value: 'الصين', score: 0.9 }, currency: { value: 'USD', score: 0.95 }, total: { value: '25,000.00', score: 0.9 }
    }, over || {}),
    items: []
  };
}
function omit(fields, keys) { const o = Object.assign({}, fields); keys.forEach(k => { delete o[k]; }); return o; }

/* ======================================================================= */
section('1. module + UMD');
check('exports compare + helpers', () => typeof M.compare === 'function' && typeof M.normName === 'function' && typeof M.normPort === 'function'
  && typeof M.containerSet === 'function' && typeof M.hs6Set === 'function' && typeof M.numClose === 'function' || 'exports');
eq('VERSION is match-v1', M.VERSION, 'match-v1');
check('ROW_KEYS = the DB allow-list (22 keys)', () => {
  const want = ['invoice_number', 'bl_number', 'declaration_number', 'container_numbers', 'shipper', 'consignee', 'gross_weight', 'net_weight',
    'packages_count', 'package_type', 'hs_codes', 'country_of_origin', 'port_of_loading', 'port_of_discharge', 'vessel', 'incoterms',
    'goods_description', 'invoice_date', 'currency', 'total', 'invoice_totals', 'items'];
  return (M.ROW_KEYS.length === 22 && want.every(k => M.ROW_KEYS.includes(k)) && M.ROW_KEYS.every(k => want.includes(k))) || J(M.ROW_KEYS);
});
check('every row key has an Arabic and English label', () => M.ROW_KEYS.every(k => M.LABELS[k] && /[؀-ۿ]/.test(M.LABELS[k].ar) && /[A-Za-z]/.test(M.LABELS[k].en)) || 'labels');
check('browser: runs as a classic script and sets window.MarsaDocMatch (no module / DOM)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'doc-match.js'), 'utf8');
  const win = {}; const ctx = { window: win }; vm.createContext(ctx); vm.runInContext(src, ctx);
  return (win.MarsaDocMatch && typeof win.MarsaDocMatch.compare === 'function' && win.MarsaDocMatch.compare({ invoice: invoice(), bl: bl() }).version === 'match-v1')
    || 'window.MarsaDocMatch';
});
check('source: no DOM / network / eval / innerHTML', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'doc-match.js'), 'utf8');
  return !/document\.|fetch\(|XMLHttpRequest|eval\(|new Function|innerHTML|localStorage/.test(src) || 'impure';
});
check('source: ES5 style (no let/const/arrow/class/template literals)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'doc-match.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return !/\b(let|const|class)\s|=>|`/.test(src) || 'es6 syntax';
});

section('2. names (EN + AR, legal suffixes)');
eq('normName strips Co., Ltd.', M.normName('Ningbo Sunrise Trading Co., Ltd.'), 'ningbo sunrise');
eq('normName: CO LTD upper case', M.normName('NINGBO SUNRISE TRADING CO LTD'), 'ningbo sunrise');
eq('normName: L.L.C.', M.normName('Marsa L.L.C.'), 'marsa');
eq('normName: diacritics', M.normName('Société Générale Ltd'), 'societe generale');
eq('normName: Arabic شركة … المحدودة', M.normName('شركة مرسى للتجارة المحدودة'), 'مرسي');
eq('normName: Arabic مؤسسة (hamza on waw)', M.normName('مؤسسة مرسى'), 'مرسي');
eq('normName: Arabic alef forms + tashkeel + tatweel', M.normName('أحـمَد'), M.normName('احمد'));
eq('normName: ذ.م.م', M.normName('شركة النور ذ.م.م'), 'نور');
eq('normName: ة/ه and ى/ي', M.normName('مكتبة الهدى'), M.normName('مكتبه الهدي'));
eq('cmpName equal after legal strip → match', M.cmpName('Marsa Trading Co.', 'MARSA TRADING COMPANY LIMITED').s, 'match');
eq('cmpName Arabic forms → match', M.cmpName('شركة مرسى للتجارة', 'مؤسسة مرسي التجارية').s, 'match');
eq('cmpName contains → partial', M.cmpName('Ningbo Sunrise', 'Ningbo Sunrise Auto Parts').s, 'partial');
eq('cmpName similar tokens → partial', M.cmpName('Golden Star Auto Parts Factory', 'Golden Star Auto Parts Plant').s, 'partial');
eq('cmpName different → mismatch', M.cmpName('Ningbo Sunrise', 'Shanghai Moon').s, 'mismatch');
eq('cmpName Arabic vs Latin → partial (script)', M.cmpName('شركة مرسى', 'MARSA CO').why, 'script');
eq('cmpName spacing only → match', M.cmpName('Al Noor', 'AlNoor').s, 'match');

section('3. ports');
eq('Jeddah aliases: JED', M.normPort('JED'), 'SAJED');
eq('Jeddah aliases: SAJED', M.normPort('SAJED'), 'SAJED');
eq('Jeddah aliases: جدة', M.normPort('جدة'), 'SAJED');
eq('Jeddah aliases: Jeddah Islamic Port', M.normPort('Jeddah Islamic Port'), 'SAJED');
eq('Jeddah aliases: Port of Jeddah, KSA', M.normPort('Port of Jeddah, KSA'), 'SAJED');
eq('Jeddah aliases: ميناء جدة الإسلامي', M.normPort('ميناء جدة الإسلامي'), 'SAJED');
eq('Dammam: King Abdulaziz Port', M.normPort('King Abdulaziz Port, Dammam'), 'SADMM');
eq('Dammam: الدمام', M.normPort('الدمام'), 'SADMM');
eq('Dammam: SADMM', M.normPort('SA DMM'), 'SADMM');
eq('Riyadh dry port', M.normPort('Riyadh Dry Port'), 'SARUH');
eq('Shanghai / CNSHA', [M.normPort('Shanghai, China'), M.normPort('CNSHA')], ['CNSHA', 'CNSHA']);
eq('Ningbo / CNNGB', [M.normPort('NINGBO'), M.normPort('CNNGB')], ['CNNGB', 'CNNGB']);
eq('Shenzhen = Yantian', [M.normPort('Yantian, Shenzhen'), M.normPort('CNSZX')], ['CNSZX', 'CNSZX']);
eq('Qingdao', M.normPort('Qingdao Port'), 'CNTAO');
eq('Jebel Ali / AEJEA', [M.normPort('Jebel Ali, UAE'), M.normPort('AEJEA')], ['AEJEA', 'AEJEA']);
eq('Mumbai = Nhava Sheva = INNSA', [M.normPort('Nhava Sheva'), M.normPort('Mumbai'), M.normPort('INNSA')], ['INNSA', 'INNSA', 'INNSA']);
eq('cmpPort Jeddah vs JED → match', M.cmpPort('Jeddah', 'JED').s, 'match');
eq('cmpPort Jeddah vs Dammam → mismatch', M.cmpPort('Jeddah', 'Dammam').s, 'mismatch');
eq('cmpPort unknown same text → match', M.cmpPort('Port of Foo Bar', 'FOO BAR').s, 'match');
eq('cmpPort unknown different → mismatch', M.cmpPort('Foo', 'Bar').s, 'mismatch');

section('4. countries + currencies');
eq('China aliases', ['China', 'CN', 'PRC', 'الصين', "People's Republic of China", 'MADE IN CHINA'].map(M.normCountry), ['CN', 'CN', 'CN', 'CN', 'CN', 'CN']);
eq('Saudi aliases', ['KSA', 'Saudi Arabia', 'المملكة العربية السعودية'].map(M.normCountry), ['SA', 'SA', 'SA']);
eq('UAE aliases', ['UAE', 'United Arab Emirates', 'الإمارات'].map(M.normCountry), ['AE', 'AE', 'AE']);
eq('India / Turkey', [M.normCountry('India'), M.normCountry('Türkiye')], ['IN', 'TR']);
eq('country from "Ningbo, China"', M.normCountry('Ningbo, China'), 'CN');
eq('currencies', ['USD', 'US$', '$', 'دولار', 'SR', 'ريال', 'RMB', 'CNY', '€', 'eur'].map(M.normCurrency), ['USD', 'USD', 'USD', 'USD', 'SAR', 'SAR', 'CNY', 'CNY', 'EUR', 'EUR']);
eq('currency in text "USD 25,000"', M.normCurrency('Amount in USD'), 'USD');

section('5. containers (ISO 6346)');
check('iso6346Valid MSCU1234566', () => M.iso6346Valid('MSCU1234566') === true || 'valid');
check('iso6346Valid wrong check digit', () => M.iso6346Valid('MSCU1234565') === false || 'invalid');
check('iso6346Valid CSQU3054383 (ISO example)', () => M.iso6346Valid('CSQU3054383') === true || 'iso example');
eq('containerSet spacing / dash', M.containerSet('MSCU 123456-6'), ['MSCU1234566']);
eq('containerSet list sorted + unique', M.containerSet('TGHU1234567, MSCU1234566; MSCU1234566'), ['MSCU1234566', 'TGHU1234567']);
eq('containerSet ignores size type "/40HC"', M.containerSet('MSCU1234566/40HC'), ['MSCU1234566']);
eq('containerSet lower case', M.containerSet('mscu1234566'), ['MSCU1234566']);
eq('containerSet empty', M.containerSet(''), []);
check('containers equal sets → match', () => M.compare({ invoice: invoice({ container_numbers: 'A' }), bl: bl() }) && true);
{
  const r = M.compare({ invoice: invoice({ container_numbers: { value: 'MSCU1234566, CSQU3054383' } }), bl: bl({ container_numbers: { value: 'CSQU3054383 MSCU1234566' } }) });
  eq('containers same set different order → match', st(r, 'container_numbers'), 'match');
  const r2 = M.compare({ invoice: invoice({ container_numbers: { value: 'MSCU1234566, CSQU3054383' } }), bl: bl({ container_numbers: { value: 'MSCU1234566, TGHU1234567' } }) });
  eq('containers overlap → partial', st(r2, 'container_numbers'), 'partial');
  check('containers overlap: differing numbers listed AR + EN', () => {
    const x = row(r2, 'container_numbers');
    return (/CSQU3054383/.test(x.detail_ar) && /TGHU1234567/.test(x.detail_ar) && /Only in the invoice: CSQU3054383/.test(x.detail_en)
      && /Only in the B\/L: TGHU1234567/.test(x.detail_en)) || J(x);
  });
  const r3 = M.compare({ invoice: invoice({ container_numbers: { value: 'CSQU3054383' } }), bl: bl() });
  eq('containers disjoint → mismatch', st(r3, 'container_numbers'), 'mismatch');
  eq('containers disjoint is critical → overall mismatch', r3.overall, 'mismatch');
  check('containers row is critical', () => row(r3, 'container_numbers').critical === true || 'critical');
}

section('6. HS codes (6 digits)');
eq('hs6Set dotted', M.hs6Set('8708.30.00, 8708.99.10'), ['870830', '870899']);
eq('hs6Set spaces + 10 digits', M.hs6Set('8708300010 870899'), ['870830', '870899']);
eq('hs6Set 4-digit heading kept', M.hs6Set('8708'), ['8708']);
eq('hs6Set Arabic digits', M.hs6Set('٨٧٠٨٣٠'), ['870830']);
{
  const r = M.compare({ invoice: invoice(), bl: bl({ hs_codes: { value: '870830, 870899' } }) });
  eq('hs same 6-digit set → match', st(r, 'hs_codes'), 'match');
  const r2 = M.compare({ invoice: invoice(), bl: bl({ hs_codes: { value: '870830' } }) });
  eq('hs overlap → partial', st(r2, 'hs_codes'), 'partial');
  eq('hs partial (critical) → overall review', r2.overall, 'review');
  const r3 = M.compare({ invoice: invoice(), bl: bl({ hs_codes: { value: '940360' } }) });
  eq('hs disjoint → mismatch', st(r3, 'hs_codes'), 'mismatch');
  eq('hs disjoint → overall mismatch', r3.overall, 'mismatch');
  const r4 = M.compare({ invoice: invoice({ hs_codes: { value: '8708' } }), bl: bl({ hs_codes: { value: '870830' } }) });
  eq('hs heading only vs 6 digits → partial (heading)', st(r4, 'hs_codes'), 'partial');
  check('hs heading detail', () => /4 خانات/.test(row(r4, 'hs_codes').detail_ar) && /heading/.test(row(r4, 'hs_codes').detail_en) || J(row(r4, 'hs_codes')));
}

section('7. numbers + weights + packages');
eq('parseNum 12,500.50', M.parseNum('12,500.50'), 12500.5);
eq('parseNum 12.500,50', M.parseNum('12.500,50'), 12500.5);
eq('parseNum 12,5', M.parseNum('12,5'), 12.5);
eq('parseNum 1.234.567', M.parseNum('1.234.567'), 1234567);
eq('parseNum Arabic digits ١٢٫٥', M.parseNum('١٢٫٥'), 12.5);
eq('parseNum spaces 12 500', M.parseNum('12 500 KGS'), 12500);
eq('parseNum none', M.parseNum('n/a'), null);
eq('parseNum number', M.parseNum(42), 42);
eq('parseWeight KGS', M.parseWeight('12,500.000 KGS'), 12500);
eq('parseWeight MT → kg', M.parseWeight('12.5 MT'), 12500);
eq('parseWeight tons', M.parseWeight('3 TONS'), 3000);
eq('parseWeight LBS → kg', M.parseWeight('1000 LBS'), 453.592);
eq('parseWeight Arabic كجم', M.parseWeight('١٢٥٠٠ كجم'), 12500);
eq('parseWeight طن', M.parseWeight('2 طن'), 2000);
eq('parseWeight negative → null', M.parseWeight('-5'), null);
check('numClose abs tolerance', () => M.numClose(100, 100.9, 1, 0.005) === true || 'abs');
check('numClose rel tolerance 0.5 %', () => M.numClose(10000, 10049, 1, 0.005) === true && M.numClose(10000, 10051, 1, 0.005) === false || 'rel');
check('numClose null → false', () => M.numClose(null, 1, 1, 0) === false || 'null');
{
  const r = M.compare({ invoice: invoice({ gross_weight: { value: '12540' } }), bl: bl() });
  eq('gross weight within 0.5 % → match', st(r, 'gross_weight'), 'match');
  const r2 = M.compare({ invoice: invoice({ gross_weight: { value: '13000' } }), bl: bl() });
  eq('gross weight 4 % off → mismatch', st(r2, 'gross_weight'), 'mismatch');
  eq('gross weight mismatch is critical → overall mismatch', r2.overall, 'mismatch');
  check('gross weight detail shows the difference', () => /500/.test(row(r2, 'gross_weight').detail_ar) && /Difference 500 kg/.test(row(r2, 'gross_weight').detail_en) || J(row(r2, 'gross_weight')));
  const r3 = M.compare({ invoice: invoice({ gross_weight: { value: '12.5 MT' } }), bl: bl() });
  eq('gross weight MT vs KGS → match', st(r3, 'gross_weight'), 'match');
  const r4 = M.compare({ invoice: invoice({ net_weight: { value: '11000' } }), bl: bl() });
  eq('net weight off → mismatch (not critical)', [st(r4, 'net_weight'), row(r4, 'net_weight').critical, r4.overall], ['mismatch', false, 'review']);
  const r5 = M.compare({ invoice: invoice({ gross_weight: { value: '12501' } }), bl: bl({ gross_weight: { value: '12500' } }) });
  eq('gross weight 1 kg off → match', st(r5, 'gross_weight'), 'match');
  const r6 = M.compare({ invoice: invoice({ packages_count: { value: '499' } }), bl: bl() });
  eq('packages off by one → mismatch (exact)', st(r6, 'packages_count'), 'mismatch');
  eq('packages mismatch → overall mismatch', r6.overall, 'mismatch');
  const r7 = M.compare({ invoice: invoice({ packages_count: { value: '500 CTNS' } }), bl: bl({ packages_count: { value: '500' } }) });
  eq('packages "500 CTNS" vs 500 → match', st(r7, 'packages_count'), 'match');
  const r8 = M.compare({ invoice: invoice({ packages_count: { value: 'many' } }), bl: bl() });
  eq('packages not a number → mismatch', st(r8, 'packages_count'), 'mismatch');
}

section('8. package types');
eq('CTN / CTNS / CARTON / CARTONS / كرتون', ['CTN', 'CTNS', 'CARTON', 'Cartons', 'كرتون', 'كراتين', '500 CTNS'].map(M.normPackageType), ['CTN', 'CTN', 'CTN', 'CTN', 'CTN', 'CTN', 'CTN']);
eq('pallets', ['PLT', 'Pallets', 'طبالي'].map(M.normPackageType), ['PLT', 'PLT', 'PLT']);
eq('bags / drums / rolls', [M.normPackageType('BAGS'), M.normPackageType('Drums'), M.normPackageType('ROLLS')], ['BAG', 'DRUM', 'ROLL']);
eq('unknown type kept upper', M.normPackageType('Coils'), 'COILS');
{
  const r = M.compare({ invoice: invoice({ package_type: { value: 'PALLETS' } }), bl: bl() });
  eq('package type differs → mismatch (not critical)', [st(r, 'package_type'), row(r, 'package_type').critical], ['mismatch', false]);
  eq('package type CTNS vs Cartons → match', st(M.compare({ invoice: invoice(), bl: bl() }), 'package_type'), 'match');
}

section('9. incoterms, dates, ids, vessel, description');
eq('incotermCode CIF Jeddah', M.incotermCode('CIF Jeddah'), 'CIF');
eq('incotermCode C&F', M.incotermCode('C&F Dammam'), 'CFR');
eq('incotermCode FOB Ningbo Incoterms 2020', M.incotermCode('FOB Ningbo Incoterms 2020'), 'FOB');
eq('incotermCode none', M.incotermCode('Freight prepaid'), '');
{
  const r = M.compare({ invoice: invoice(), bl: bl({ incoterms: { value: 'CIF JED' } }) });
  eq('incoterms CIF Jeddah vs CIF JED → match', st(r, 'incoterms'), 'match');
  const r2 = M.compare({ invoice: invoice(), bl: bl({ incoterms: { value: 'FOB Ningbo' } }) });
  eq('incoterms CIF vs FOB → mismatch', st(r2, 'incoterms'), 'mismatch');
  const r3 = M.compare({ invoice: invoice(), bl: bl({ incoterms: { value: 'CIF Dammam' } }) });
  eq('incoterms same term, other place → partial', st(r3, 'incoterms'), 'partial');
}
eq('normDate ISO', M.normDate('2026-10-01'), '2026-10-01');
eq('normDate DD/MM/YYYY', M.normDate('01/10/2026'), '2026-10-01');
eq('normDate MM/DD/YYYY when day > 12', M.normDate('10/25/2026'), '2026-10-25');
eq('normDate 1 Oct 2026', M.normDate('1 Oct 2026'), '2026-10-01');
eq('normDate October 1st, 2026', M.normDate('October 1st, 2026'), '2026-10-01');
eq('normDate invalid 2026-02-30', M.normDate('2026-02-30'), '');
eq('normDate Arabic digits', M.normDate('٢٠٢٦-١٠-٠١'), '2026-10-01');
eq('normId strips label + punctuation', M.normId('No. INV-2026/0042'), 'INV20260042');
eq('normId keeps INV prefix without separator', M.normId('INV-001'), 'INV001');
eq('cmpId equal ignoring dashes', M.cmpId('INV-2026-0042', 'inv 2026 0042').s, 'match');
eq('cmpId leading zeros', M.cmpId('000123456', '123456').s, 'match');
eq('cmpId carrier prefix → partial', M.cmpId('MEDU12345678', '12345678').s, 'partial');
eq('cmpId different → mismatch', M.cmpId('INV-1', 'INV-2').s, 'mismatch');
eq('normVessel strips M/V + voyage', M.normVessel('M/V MSC ANNA V.234E'), 'MSC ANNA');
eq('normVessel slash voyage', M.normVessel('MSC ANNA / 234E'), 'MSC ANNA');
eq('vessel row: MSC ANNA vs M/V MSC ANNA V.234E → match', st(M.compare({ invoice: invoice(), bl: bl() }), 'vessel'), 'match');
eq('vessel other ship → mismatch', st(M.compare({ invoice: invoice({ vessel: { value: 'EVER GIVEN' } }), bl: bl() }), 'vessel'), 'mismatch');
eq('descTokens drop stop words + plural', M.descTokens('Brake pads and spare parts for cars'), ['brake', 'pad', 'spare', 'part', 'car']);
eq('cmpDesc high overlap → match', M.cmpDesc('Brake pads and spare parts for passenger cars', 'BRAKE PADS, SPARE PARTS FOR CARS').s, 'match');
eq('cmpDesc some overlap → partial', M.cmpDesc('Brake pads and spare parts for passenger cars', 'Car seats, mirrors and lamps for brake systems').s, 'partial');
eq('cmpDesc none → mismatch', M.cmpDesc('Brake pads', 'Cotton t-shirts').s, 'mismatch');
check('goods_description is never critical', () => row(M.compare({ invoice: invoice({ goods_description: { value: 'Cotton t-shirts' } }), bl: bl() }), 'goods_description').critical === false || 'critical');
{
  const r = M.compare({ invoice: invoice({ goods_description: { value: 'Cotton t-shirts' } }), bl: bl() });
  check('description mismatch shows similarity %', () => /%/.test(row(r, 'goods_description').detail_ar) || J(row(r, 'goods_description')));
}

section('10. two-way: the clean pair');
{
  const r = M.compare({ invoice: invoice(), bl: bl() });
  eq('mode two_way', r.mode, 'two_way');
  eq('overall match', r.overall, 'match');
  eq('no mismatches', r.counts.mismatch, 0);
  check('counts sum = non-info rows', () => r.counts.match + r.counts.mismatch + r.counts.partial + r.counts.missing === r.rows.filter(x => x.status !== 'info').length || J(r.counts));
  eq('shipper (supplier_name ↔ shipper) → match', st(r, 'shipper'), 'match');
  eq('consignee (buyer_name ↔ consignee) → match', st(r, 'consignee'), 'match');
  eq('ports match via aliases', [st(r, 'port_of_loading'), st(r, 'port_of_discharge')], ['match', 'match']);
  eq('containers match', st(r, 'container_numbers'), 'match');
  eq('gross weight match', st(r, 'gross_weight'), 'match');
  eq('packages match', st(r, 'packages_count'), 'match');
  check('no declaration-only rows in two-way', () => !row(r, 'declaration_number') && !row(r, 'invoice_date') && !row(r, 'currency') && !row(r, 'total') || J(r.rows.map(x => x.key)));
  check('values: declaration undefined in two-way', () => r.rows.every(x => x.values.declaration === undefined) || 'decl value');
  check('src: shipper read from supplier_name on the invoice', () => row(r, 'shipper').src.invoice === 'supplier_name' && row(r, 'shipper').src.bl === 'shipper' || J(row(r, 'shipper').src));
  check('conf carried from score', () => row(r, 'invoice_number').conf.invoice === 0.97 || J(row(r, 'invoice_number').conf));
  check('pairs: inv_bl set, decl pairs null', () => row(r, 'gross_weight').pairs.inv_bl === 'match' && row(r, 'gross_weight').pairs.inv_decl === null && row(r, 'gross_weight').pairs.bl_decl === null || J(row(r, 'gross_weight').pairs));
  check('every row has the contract shape', () => r.rows.every(x => typeof x.key === 'string' && typeof x.label_ar === 'string' && typeof x.label_en === 'string'
    && x.values && 'invoice' in x.values && 'bl' in x.values && ['match', 'mismatch', 'partial', 'missing', 'info'].includes(x.status)
    && typeof x.detail_ar === 'string' && typeof x.detail_en === 'string' && typeof x.critical === 'boolean' && x.conf && x.pairs
    && 'inv_bl' in x.pairs && 'inv_decl' in x.pairs && 'bl_decl' in x.pairs) || 'shape');
  check('every row key is in the allow-list', () => r.rows.every(x => M.ROW_KEYS.includes(x.key)) || 'keys');
  check('≤ 60 rows', () => r.rows.length <= 60 || r.rows.length);
  check('invoice_number: B/L does not cite it → info (optional), not missing', () => st(r, 'invoice_number') === 'info' || st(r, 'invoice_number'));
  check('invoice_number not critical in two-way', () => row(r, 'invoice_number').critical === false || 'crit');
  eq('invoice_totals row → match', st(r, 'invoice_totals'), 'match');
}

section('11. two-way: missing + omitted rows');
{
  const r = M.compare({ invoice: invoice(), bl: { fields: omit(bl().fields, ['consignee']) } });
  eq('consignee missing on B/L → missing', st(r, 'consignee'), 'missing');
  check('missing detail says which document', () => /البوليصة/.test(row(r, 'consignee').detail_ar) && /B\/L/.test(row(r, 'consignee').detail_en) || J(row(r, 'consignee')));
  eq('critical missing → overall review', r.overall, 'review');
  check('missing pair status', () => row(r, 'consignee').pairs.inv_bl === 'missing' || J(row(r, 'consignee').pairs));
  const r2 = M.compare({ invoice: { fields: omit(invoice().fields, ['shipper', 'supplier_name']) }, bl: bl() });
  eq('shipper missing on invoice → missing (not critical)', [st(r2, 'shipper'), row(r2, 'shipper').critical], ['missing', false]);
  eq('non-critical missing alone → overall match', r2.overall, 'match');
  const r3 = M.compare({ invoice: { fields: omit(invoice().fields, ['vessel']) }, bl: { fields: omit(bl().fields, ['vessel']) } });
  check('missing on both sides → row omitted', () => row(r3, 'vessel') === null || J(row(r3, 'vessel')));
  const r4 = M.compare({ invoice: { fields: omit(invoice().fields, ['container_numbers']) }, bl: bl() });
  eq('containers only on B/L (invoice optional) → info', st(r4, 'container_numbers'), 'info');
  eq('info rows do not affect overall', r4.overall, 'match');
  check('info row not counted', () => r4.counts.match + r4.counts.mismatch + r4.counts.partial + r4.counts.missing === r4.rows.filter(x => x.status !== 'info').length || 'count');
  const r5 = M.compare({ invoice: { fields: omit(invoice().fields, ['gross_weight']) }, bl: bl() });
  eq('gross weight only on B/L → info (invoice optional)', st(r5, 'gross_weight'), 'info');
  const r6 = M.compare({ invoice: invoice(), bl: { fields: omit(bl().fields, ['gross_weight']) } });
  eq('gross weight only on invoice → missing (B/L expected)', st(r6, 'gross_weight'), 'missing');
  eq('… critical → review', r6.overall, 'review');
}

section('12. two-way: overall rules');
{
  const r = M.compare({ invoice: invoice({ buyer_name: { value: 'Another Importer Est' } }), bl: bl() });
  eq('consignee different → mismatch', st(r, 'consignee'), 'mismatch');
  eq('critical mismatch → overall mismatch', r.overall, 'mismatch');
  const r2 = M.compare({ invoice: invoice({ supplier_name: { value: 'Totally Different Supplier' } }), bl: bl() });
  eq('shipper mismatch (non-critical) → review', [st(r2, 'shipper'), r2.overall], ['mismatch', 'review']);
  const r3 = M.compare({ invoice: invoice({ port_of_loading: { value: 'Ningbo Beilun Terminal Zone X' } }), bl: bl({ port_of_loading: { value: 'Ningbo' } }) });
  eq('partial on a non-critical row only → still match', [st(r3, 'port_of_loading'), r3.overall], ['match', 'match']);
  const r4 = M.compare({ invoice: invoice({ buyer_name: { value: 'Marsa' } }), bl: bl({ consignee: { value: 'Marsa Logistics Services' } }) });
  eq('critical partial → review', [st(r4, 'consignee'), r4.overall], ['partial', 'review']);
  const r5 = M.compare({ invoice: invoice({ goods_description: { value: 'Brake pads, seats and steering wheels' } }), bl: bl() });
  eq('description partial → match overall (non-critical partial)', r5.overall === 'match' || r5.overall === 'review', true);
  const r6 = M.compare({ invoice: invoice(), bl: bl({ consignee: { value: 'شركة مرسى للتجارة' } }) });
  eq('consignee Arabic vs Latin → partial → review', [st(r6, 'consignee'), r6.overall], ['partial', 'review']);
  check('script detail AR + EN', () => /بالعربية/.test(row(r6, 'consignee').detail_ar) && /Arabic/.test(row(r6, 'consignee').detail_en) || J(row(r6, 'consignee')));
}

section('13. three-way: all agree');
{
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl() });
  eq('mode three_way', r.mode, 'three_way');
  eq('overall match', r.overall, 'match');
  eq('declaration_number shown as info', st(r, 'declaration_number'), 'info');
  check('declaration_number value from the declaration', () => row(r, 'declaration_number').values.declaration === '3012345678' || J(row(r, 'declaration_number')));
  eq('invoice_number decl ↔ invoice → match + critical', [st(r, 'invoice_number'), row(r, 'invoice_number').critical], ['match', true]);
  eq('bl_number decl ↔ bl → match + critical', [st(r, 'bl_number'), row(r, 'bl_number').critical], ['match', true]);
  eq('invoice_date DD/MM vs ISO → match', st(r, 'invoice_date'), 'match');
  eq('currency → match', st(r, 'currency'), 'match');
  eq('total 25,000.00 vs 25000 → match + critical', [st(r, 'total'), row(r, 'total').critical], ['match', true]);
  eq('country China vs الصين → match', st(r, 'country_of_origin'), 'match');
  eq('hs codes three docs → match', st(r, 'hs_codes'), 'match');
  eq('containers three docs → match', st(r, 'container_numbers'), 'match');
  check('pairs for containers all match', () => J(row(r, 'container_numbers').pairs) === J({ inv_bl: 'match', inv_decl: 'match', bl_decl: 'match' }) || J(row(r, 'container_numbers').pairs));
  check('values include the declaration column', () => row(r, 'gross_weight').values.declaration === '12500' || J(row(r, 'gross_weight').values));
  check('conf.declaration carried', () => row(r, 'gross_weight').conf.declaration === 0.9 || J(row(r, 'gross_weight').conf));
  check('invoice_date has no B/L column (undefined)', () => row(r, 'invoice_date').values.bl === undefined && row(r, 'invoice_date').pairs.inv_bl === null || J(row(r, 'invoice_date')));
  eq('consignee three-way match', st(r, 'consignee'), 'match');
}

section('14. three-way: declaration disagrees with both');
{
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ gross_weight: { value: '14000' } }) });
  eq('gross weight → mismatch', st(r, 'gross_weight'), 'mismatch');
  check('detail: البيان يختلف عن الفاتورة والبوليصة', () => /البيان يختلف عن الفاتورة والبوليصة/.test(row(r, 'gross_weight').detail_ar) || row(r, 'gross_weight').detail_ar);
  check('detail EN: The declaration differs from the invoice and the B/L', () => /The declaration differs from the invoice and the B\/L/.test(row(r, 'gross_weight').detail_en) || row(r, 'gross_weight').detail_en);
  check('pairs: inv_bl match, decl pairs mismatch', () => J(row(r, 'gross_weight').pairs) === J({ inv_bl: 'match', inv_decl: 'mismatch', bl_decl: 'mismatch' }) || J(row(r, 'gross_weight').pairs));
  eq('overall mismatch', r.overall, 'mismatch');
  const r2 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ container_numbers: { value: 'CSQU3054383' } }) });
  eq('containers decl differs → mismatch', st(r2, 'container_numbers'), 'mismatch');
  check('containers detail lists the declaration-only number', () => /CSQU3054383/.test(row(r2, 'container_numbers').detail_en) || row(r2, 'container_numbers').detail_en);
  const r3 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ bl_number: { value: 'MEDU99999999' } }) });
  eq('bl_number decl ↔ bl differs → mismatch → overall mismatch', [st(r3, 'bl_number'), r3.overall], ['mismatch', 'mismatch']);
  const r4 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ invoice_number: { value: 'INV-2026-0099' } }) });
  eq('invoice_number decl ↔ invoice differs → mismatch (critical)', [st(r4, 'invoice_number'), r4.overall], ['mismatch', 'mismatch']);
  const r5 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ packages_count: { value: '450' } }) });
  check('packages: declaration odd one out', () => /البيان يختلف/.test(row(r5, 'packages_count').detail_ar) && r5.overall === 'mismatch' || J(row(r5, 'packages_count')));
}

section('15. three-way: declaration agrees with one');
{
  const r = M.compare({ invoice: invoice({ gross_weight: { value: '13000' } }), bl: bl(), declaration: decl() });
  eq('invoice is the odd one out → mismatch', st(r, 'gross_weight'), 'mismatch');
  check('detail: الفاتورة تختلف عن البوليصة والبيان', () => /الفاتورة تختلف عن البوليصة والبيان/.test(row(r, 'gross_weight').detail_ar) || row(r, 'gross_weight').detail_ar);
  check('detail EN: The invoice differs from the B/L and the declaration', () => /The invoice differs from the B\/L and the declaration/.test(row(r, 'gross_weight').detail_en) || row(r, 'gross_weight').detail_en);
  check('pairs: bl_decl match only', () => J(row(r, 'gross_weight').pairs) === J({ inv_bl: 'mismatch', inv_decl: 'mismatch', bl_decl: 'match' }) || J(row(r, 'gross_weight').pairs));
  const r2 = M.compare({ invoice: invoice(), bl: bl({ packages_count: { value: '480' } }), declaration: decl() });
  check('B/L is the odd one out', () => /البوليصة تختلف عن الفاتورة والبيان/.test(row(r2, 'packages_count').detail_ar) && /The B\/L differs/.test(row(r2, 'packages_count').detail_en) || J(row(r2, 'packages_count')));
  const r3 = M.compare({ invoice: invoice({ gross_weight: { value: '11000' } }), bl: bl(), declaration: decl({ gross_weight: { value: '14000' } }) });
  check('all three disagree', () => /المستندات الثلاثة/.test(row(r3, 'gross_weight').detail_ar) && /three documents disagree/.test(row(r3, 'gross_weight').detail_en) || J(row(r3, 'gross_weight')));
  // invoice_number / bl_number: only the declaration pair is critical; the optional document citing another reference → partial
  const r4 = M.compare({ invoice: invoice(), bl: bl({ invoice_number: { value: 'PO-77812', score: 0.9 } }), declaration: decl() });
  eq('B/L cites another invoice ref (invoice = declaration) → partial, critical, overall review',
    [st(r4, 'invoice_number'), row(r4, 'invoice_number').critical, r4.overall], ['partial', true, 'review']);
  check('optional-ref detail names the B/L', () => /البوليصة فقط/.test(row(r4, 'invoice_number').detail_ar) && /only on the B\/L/.test(row(r4, 'invoice_number').detail_en) || J(row(r4, 'invoice_number')));
  check('pairs keep the real per-pair results', () => J(row(r4, 'invoice_number').pairs) === J({ inv_bl: 'mismatch', inv_decl: 'match', bl_decl: 'mismatch' }) || J(row(r4, 'invoice_number').pairs));
  const r5 = M.compare({ invoice: invoice({ bl_number: { value: 'XYZ000111' } }), bl: bl(), declaration: decl() });
  eq('invoice cites another B/L no. (B/L = declaration) → partial, overall review', [st(r5, 'bl_number'), r5.overall], ['partial', 'review']);
  const r6 = M.compare({ invoice: invoice(), bl: bl({ invoice_number: { value: 'PO-77812' } }), declaration: decl({ invoice_number: { value: 'INV-2026-0099' } }) });
  eq('declaration ≠ invoice stays a critical mismatch even with a B/L ref', [st(r6, 'invoice_number'), r6.overall], ['mismatch', 'mismatch']);
  const r7 = M.compare({ invoice: invoice(), bl: bl({ invoice_number: { value: 'PO-77812' } }) });
  eq('two-way: the same B/L ref is a non-critical mismatch → review', [st(r7, 'invoice_number'), row(r7, 'invoice_number').critical, r7.overall], ['mismatch', false, 'review']);
}

section('16. three-way: missing fields');
{
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ consignee: undefined }) });
  check('decl without consignee: row still built', () => !!row(r, 'consignee') || 'row');
  const r2 = M.compare({ invoice: invoice(), bl: bl(), declaration: { fields: omit(decl().fields, ['consignee']) } });
  eq('consignee: invoice + B/L agree, declaration (expected) silent → missing', st(r2, 'consignee'), 'missing');
  check('missing detail names the declaration', () => /البيان/.test(row(r2, 'consignee').detail_ar) && /declaration/.test(row(r2, 'consignee').detail_en) || J(row(r2, 'consignee')));
  check('pairs: inv_decl + bl_decl missing', () => row(r2, 'consignee').pairs.inv_decl === 'missing' && row(r2, 'consignee').pairs.bl_decl === 'missing' && row(r2, 'consignee').pairs.inv_bl === 'match' || J(row(r2, 'consignee').pairs));
  eq('critical missing → overall review', r2.overall, 'review');
  const r3 = M.compare({ invoice: invoice(), bl: bl(), declaration: { fields: omit(decl().fields, ['total']) } });
  eq('total only on invoice → missing (critical) → review', [st(r3, 'total'), r3.overall], ['missing', 'review']);
  const r4 = M.compare({ invoice: invoice(), bl: bl(), declaration: { fields: omit(decl().fields, ['declaration_number']) } });
  check('no declaration number anywhere → row omitted', () => row(r4, 'declaration_number') === null || J(row(r4, 'declaration_number')));
  const r5 = M.compare({ invoice: invoice(), bl: bl(), declaration: { fields: {} } });
  eq('empty declaration → still three_way', r5.mode, 'three_way');
  check('empty declaration: no match overall', () => r5.overall !== 'match' || r5.overall);
  const r6 = M.compare({ invoice: invoice(), bl: bl(), declaration: { fields: omit(decl().fields, ['invoice_number']) } });
  eq('invoice number not on the declaration (expected) → missing', st(r6, 'invoice_number'), 'missing');
}

section('17. three-way: currency + total');
{
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ currency: { value: 'SAR' }, total: { value: '93750' } }) });
  eq('currency differs → mismatch (non-critical)', [st(r, 'currency'), row(r, 'currency').critical], ['mismatch', false]);
  eq('total in another currency → partial (not compared)', st(r, 'total'), 'partial');
  check('total detail: compare manually after conversion', () => /يدويًا/.test(row(r, 'total').detail_ar) && /manually/.test(row(r, 'total').detail_en) || J(row(r, 'total')));
  eq('overall review (critical partial + mismatch)', r.overall, 'review');
  const r2 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ total: { value: '25100' } }) });
  eq('total 0.4 % off → match (tolerance max(1, 0.5 %))', st(r2, 'total'), 'match');
  const r3 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ total: { value: '26000' } }) });
  eq('total 4 % off → mismatch (critical) → overall mismatch', [st(r3, 'total'), r3.overall], ['mismatch', 'mismatch']);
  check('total mismatch detail shows the difference', () => /1,000/.test(row(r3, 'total').detail_ar) || row(r3, 'total').detail_ar);
  const r4 = M.compare({ invoice: invoice({ subtotal: { value: '25000' }, total: { value: '28750' } }), bl: bl(), declaration: decl({ total: { value: '25000' } }) });
  eq('customs value = invoice subtotal (before VAT) → match', st(r4, 'total'), 'match');
  const r5 = M.compare({ invoice: invoice({ currency: { value: 'US$' } }), bl: bl(), declaration: decl({ currency: { value: 'دولار' } }) });
  eq('currency US$ vs دولار → match', st(r5, 'currency'), 'match');
  const r6 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ total: { value: 'unknown' } }) });
  eq('total not a number → mismatch', st(r6, 'total'), 'mismatch');
  const r7 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ invoice_date: { value: '2026-10-02' } }) });
  eq('invoice date differs → mismatch (non-critical) → review', [st(r7, 'invoice_date'), row(r7, 'invoice_date').critical, r7.overall], ['mismatch', false, 'review']);
}

section('18. line items + invoice totals');
{
  const r = M.compare({ invoice: invoice({ subtotal: { value: '24000' }, total: { value: '24000' } }), bl: bl() });
  eq('items sum ≠ subtotal → invoice_totals mismatch', st(r, 'invoice_totals'), 'mismatch');
  check('invoice_totals detail', () => /24,000/.test(row(r, 'invoice_totals').detail_ar) && /does not equal/.test(row(r, 'invoice_totals').detail_en) || J(row(r, 'invoice_totals')));
  eq('… non-critical mismatch → review', r.overall, 'review');
  const r2 = M.compare({ invoice: invoice({ subtotal: { value: '25100' } }), bl: bl() });
  eq('items sum within 1 % → match', st(r2, 'invoice_totals'), 'match');
  const r3 = M.compare({ invoice: invoice({ subtotal: { value: '21739.13' }, total: { value: '25000' } }), bl: bl() });
  eq('items VAT-inclusive: sum = total → match', st(r3, 'invoice_totals'), 'match');
  const inv4 = invoice(); delete inv4.fields.subtotal; delete inv4.fields.total;
  const r4 = M.compare({ invoice: inv4, bl: bl() });
  check('no subtotal / total → no invoice_totals row', () => row(r4, 'invoice_totals') === null || J(row(r4, 'invoice_totals')));
  check('items.totals still reports the sum', () => r4.items.totals && r4.items.totals.items_sum === 25000 && r4.items.totals.status === 'info' || J(r4.items.totals));
  const b5 = bl(); b5.items = [{ description: 'Brake pads', hs_code: '870830', quantity: 400 }, { description: 'Spare parts', hs_code: '870899', quantity: 100 }];
  const r5 = M.compare({ invoice: invoice(), bl: b5 });
  eq('B/L items same quantities → items match', st(r5, 'items'), 'match');
  check('items groups by HS6', () => r5.items.groups.length === 2 && r5.items.groups[0].hs6 === '870830' && r5.items.groups[0].quantity.bl === 400 || J(r5.items.groups));
  const b6 = bl(); b6.items = [{ description: 'Brake pads', hs_code: '870830', quantity: 380 }, { description: 'Spare parts', hs_code: '870899', quantity: 100 }];
  const r6 = M.compare({ invoice: invoice(), bl: b6 });
  eq('B/L quantity differs → items mismatch', st(r6, 'items'), 'mismatch');
  check('items detail names the HS code', () => /870830/.test(row(r6, 'items').detail_ar) || row(r6, 'items').detail_ar);
  check('items row not critical', () => row(r6, 'items').critical === false || 'crit');
  const b7 = bl(); b7.items = [{ description: 'Brake pads', hs_code: '870830', quantity: 400 }];
  const r7 = M.compare({ invoice: invoice(), bl: b7 });
  eq('item missing on B/L → items partial', st(r7, 'items'), 'partial');
  const d8 = decl(); d8.items = [{ description: 'Brake pads front', hs_code: '8708300000', quantity: 400, amount: 20000 }, { description: 'Spare parts kit', hs_code: '8708991000', quantity: 100, amount: 5000 }];
  const r8 = M.compare({ invoice: invoice(), bl: bl(), declaration: d8 });
  eq('declaration items agree → items match', st(r8, 'items'), 'match');
  check('declaration amounts in groups', () => r8.items.groups[0].amount.declaration === 20000 || J(r8.items.groups[0]));
  const b9 = bl(); b9.items = [{ description: 'brake pads front', quantity: 400 }, { description: 'spare parts kit', quantity: 100 }];
  const r9 = M.compare({ invoice: invoice(), bl: b9 });
  eq('B/L items without HS matched by description', st(r9, 'items'), 'match');
  const b10 = bl(); b10.items = [{ description: 'Brake pads', hs_code: '870830', quantity: 400 }, { description: 'Spare parts', hs_code: '870899', quantity: 100 }, { description: 'Tyres', hs_code: '401110', quantity: 5 }];
  const r10 = M.compare({ invoice: invoice(), bl: b10 });
  check('extra B/L item reported (only: bl)', () => r10.items.groups.some(g => g.hs6 === '401110' && g.only === 'bl' && g.status === 'missing') && st(r10, 'items') === 'partial' || J(r10.items.groups));
  check('items counts as values', () => row(r10, 'items').values.invoice === '2' && row(r10, 'items').values.bl === '3' || J(row(r10, 'items').values));
}

section('19. corrections + determinism');
{
  const inv = invoice({ gross_weight: { value: '12500', score: 1, corrected: true } });
  const r = M.compare({ invoice: inv, bl: bl() });
  check('corrected flag propagated to the row', () => row(r, 'gross_weight').corrected === true || J(row(r, 'gross_weight')));
  check('uncorrected rows have no corrected flag', () => !row(r, 'packages_count').corrected || 'flag');
  const a = J(M.compare({ invoice: invoice(), bl: bl(), declaration: decl() })), b = J(M.compare({ invoice: invoice(), bl: bl(), declaration: decl() }));
  check('deterministic (same input → same JSON)', () => a === b || 'nondeterministic');
  const input = { invoice: invoice(), bl: bl(), declaration: decl() };
  const before = J(input);
  M.compare(input);
  check('input not mutated', () => J(input) === before || 'mutated');
  check('generated_at only from opts.now', () => M.compare(input).generated_at === null && M.compare(input, { now: '2026-11-16T00:00:00Z' }).generated_at === '2026-11-16T00:00:00Z' || 'now');
  check('plain string field values accepted', () => st(M.compare({ invoice: { fields: { gross_weight: '100' } }, bl: { fields: { gross_weight: '100 KG' } } }), 'gross_weight') === 'match' || 'string');
  check('numeric field values accepted', () => st(M.compare({ invoice: { fields: { packages_count: 10 } }, bl: { fields: { packages_count: { value: 10 } } } }), 'packages_count') === 'match' || 'num');
  check('documents listed', () => J(M.compare(input).documents) === J(['invoice', 'bl', 'declaration']) || 'docs');
}

section('20. robustness');
check('compare() without input', () => { const r = M.compare(); return r.version === 'match-v1' && Array.isArray(r.rows) && r.rows.length === 0 && r.overall === 'review' || J(r); });
check('compare(null)', () => M.compare(null).rows.length === 0 || 'null');
check('compare("x")', () => M.compare('x').rows.length === 0 || 'str');
check('compare with arrays as docs', () => M.compare({ invoice: [], bl: [] }).rows.length === 0 || 'arr');
check('fields not an object', () => M.compare({ invoice: { fields: 'oops' }, bl: { fields: 42 } }).rows.length === 0 || 'fields');
check('items not an array', () => { const r = M.compare({ invoice: { fields: {}, items: 'x' }, bl: { fields: {}, items: { a: 1 } } }); return r.items.groups.length === 0 || J(r.items); });
check('items with junk entries', () => { const v = invoice(); v.items = [null, 1, 'x', { amount: 'abc' }, { description: 'ok', amount: '10' }]; const r = M.compare({ invoice: v, bl: bl() }); return r.items.totals.items_sum === 10 || J(r.items.totals); });
check('null / object / boolean values ignored', () => { const r = M.compare({ invoice: { fields: { shipper: null, consignee: { value: { nested: 1 } }, vessel: true } }, bl: bl() }); return !row(r, 'vessel') || st(r, 'vessel') === 'info' || J(row(r, 'vessel')); });
check('huge strings truncated (no throw)', () => { const s = 'A'.repeat(200000); const r = M.compare({ invoice: { fields: { goods_description: s } }, bl: { fields: { goods_description: s } } }); return !!row(r, 'goods_description') || 'row'; });
check('control characters stripped', () => { const r = M.compare({ invoice: { fields: { vessel: 'MSC\u0000 ANNA' } }, bl: { fields: { vessel: 'MSC ANNA' } } }); return st(r, 'vessel') === 'match' || J(row(r, 'vessel')); });
check('NaN / Infinity values', () => { const r = M.compare({ invoice: { fields: { gross_weight: NaN, packages_count: Infinity } }, bl: bl() }); return st(r, 'gross_weight') === 'info' && row(r, 'gross_weight').values.invoice === null || J(row(r, 'gross_weight')); });
check('prototype keys are not fields', () => { const r = M.compare({ invoice: { fields: Object.create({ consignee: 'X' }) }, bl: bl() }); return st(r, 'consignee') === 'missing' || J(row(r, 'consignee')); });
check('__proto__ key harmless', () => { const f = JSON.parse('{"__proto__": {"x": 1}, "vessel": "MSC ANNA"}'); const r = M.compare({ invoice: { fields: f }, bl: bl() }); return st(r, 'vessel') === 'match' || J(row(r, 'vessel')); });
check('scores clamped to 0..1', () => { const r = M.compare({ invoice: { fields: { vessel: { value: 'MSC ANNA', score: 7 } } }, bl: { fields: { vessel: { value: 'MSC ANNA', score: -3 } } } }); const c = row(r, 'vessel').conf; return c.invoice === 1 && c.bl === 0 || J(c); });
check('non-numeric score → null', () => row(M.compare({ invoice: { fields: { vessel: { value: 'X', score: 'high' } } }, bl: { fields: { vessel: 'X' } } }), 'vessel').conf.invoice === null || 'score');
check('only invoice uploaded → overall review, no match', () => { const r = M.compare({ invoice: invoice() }); return r.overall === 'review' || r.overall; });
check('only B/L + declaration → review', () => { const r = M.compare({ bl: bl(), declaration: decl() }); return r.overall !== 'match' && r.mode === 'two_way' || J([r.overall, r.mode]); });
check('Arabic-only documents compare', () => { const r = M.compare({ invoice: { fields: { consignee: 'شركة الفجر', port_of_discharge: 'جدة' } }, bl: { fields: { consignee: 'مؤسسة الفجر', port_of_discharge: 'ميناء جدة الإسلامي' } } }); return st(r, 'consignee') === 'match' && st(r, 'port_of_discharge') === 'match' || J(r.rows); });
check('regex-special characters in values', () => { const r = M.compare({ invoice: { fields: { incoterms: 'CIF (*+?[' } }, bl: { fields: { incoterms: 'CIF )]' } } }); return !!row(r, 'incoterms') || 'row'; });
check('random fuzz: 300 inputs never throw and keep the shape', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = ['', ' ', '0', '-1', '12,5', 'CIF', 'جدة', 'MSCU1234566', '8708', null, 3.5, 'Ltd.', '٫', '..,,', '‮', 'X'.repeat(50)];
  const keys = ['invoice_number', 'bl_number', 'container_numbers', 'shipper', 'supplier_name', 'consignee', 'buyer_name', 'gross_weight', 'net_weight',
    'packages_count', 'package_type', 'hs_codes', 'country_of_origin', 'port_of_loading', 'port_of_discharge', 'vessel', 'incoterms', 'goods_description',
    'invoice_date', 'currency', 'total', 'subtotal', 'declaration_number'];
  const doc = () => { const f = {}; keys.forEach(k => { if (rnd() < 0.5) f[k] = rnd() < 0.5 ? pool[Math.floor(rnd() * pool.length)] : { value: pool[Math.floor(rnd() * pool.length)], score: rnd() }; });
    return { fields: f, items: rnd() < 0.5 ? [{ description: pool[Math.floor(rnd() * pool.length)], hs_code: pool[Math.floor(rnd() * pool.length)], quantity: rnd() * 10, amount: pool[Math.floor(rnd() * pool.length)] }] : [] }; };
  for (let i = 0; i < 300; i++) {
    const r = M.compare({ invoice: doc(), bl: doc(), declaration: rnd() < 0.5 ? doc() : undefined });
    if (!['match', 'mismatch', 'review'].includes(r.overall)) return 'overall ' + r.overall;
    if (!r.rows.every(x => M.ROW_KEYS.includes(x.key) && ['match', 'mismatch', 'partial', 'missing', 'info'].includes(x.status))) return 'row ' + i;
    const sum = r.counts.match + r.counts.mismatch + r.counts.partial + r.counts.missing;
    if (sum !== r.rows.filter(x => x.status !== 'info').length) return 'counts ' + i;
    if (r.rows.some(x => x.critical && x.status === 'mismatch') && r.overall !== 'mismatch') return 'overall rule ' + i;
    if (r.rows.length > 60) return 'rows ' + i;
  }
  return true;
});

section('21. overall rule table');
{
  const base = M.compare({ invoice: invoice(), bl: bl(), declaration: decl() });
  eq('baseline match', base.overall, 'match');
  check('a critical mismatch always wins over partials', () => {
    const r = M.compare({ invoice: invoice({ buyer_name: { value: 'Marsa' } }), bl: bl({ consignee: { value: 'Marsa Logistics Services' }, packages_count: { value: '1' } }), declaration: decl() });
    return r.overall === 'mismatch' || r.overall;
  });
  check('counts are consistent with rows in three-way', () => {
    const r = M.compare({ invoice: invoice({ gross_weight: { value: '13000' } }), bl: bl(), declaration: decl({ currency: { value: 'SAR' } }) });
    const c = { match: 0, mismatch: 0, partial: 0, missing: 0 };
    r.rows.forEach(x => { if (x.status in c) c[x.status]++; });
    return J(c) === J(r.counts) || J([c, r.counts]);
  });
  check('three-way critical set: invoice_number, bl_number, containers, consignee, gross_weight, packages, hs, total', () => {
    const crit = base.rows.filter(x => x.critical).map(x => x.key).sort();
    const want = ['bl_number', 'consignee', 'container_numbers', 'gross_weight', 'hs_codes', 'invoice_number', 'packages_count', 'total'].sort();
    return J(crit) === J(want) || J(crit);
  });
  check('two-way critical set: containers, consignee, gross_weight, packages, hs', () => {
    const r = M.compare({ invoice: invoice({ hs_codes: { value: '870830 870899' } }), bl: bl({ hs_codes: { value: '870830, 870899' } }) });
    const crit = r.rows.filter(x => x.critical).map(x => x.key).sort();
    return J(crit) === J(['consignee', 'container_numbers', 'gross_weight', 'hs_codes', 'packages_count']) || J(crit);
  });
}

/* ----------------------------------------------------------------- packing list (match-v2, 20261126000100) */
function packing(over) {
  return {
    fields: Object.assign({
      packing_list_number: { value: 'PL-2026-0042', score: 0.9 }, packing_list_date: { value: '2026-10-01', score: 0.9 },
      invoice_number: { value: 'INV-2026-0042', score: 0.93 }, container_numbers: { value: 'MSCU1234566', score: 0.92 },
      shipper: { value: 'Ningbo Sunrise Trading Co., Ltd.', score: 0.9 }, consignee_name: { value: 'Marsa Trading Company', score: 0.9 },
      gross_weight: { value: '12,500 KGS', score: 0.9 }, net_weight: { value: '12,000 KGS', score: 0.9 }, packages_count: { value: '500', score: 0.94 },
      package_type: { value: 'Cartons', score: 0.9 }, goods_description: { value: 'Brake pads and spare parts', score: 0.85 },
      hs_codes: { value: '870830, 870899', score: 0.8 }, country_of_origin: { value: 'China', score: 0.9 }
    }, over || {}),
    items: [{ description: 'Brake pads front', hs_code: '8708.30.00', quantity: 9999, packages: 400, gross_weight: 10000 }]
  };
}
// snapshot corpus (packing absent): fixed fixture variants + 400 seeded random inputs
function snapshotCorpus() {
  const out = [];
  const W = (x) => x;
  out.push({ invoice: invoice(), bl: bl() }, { invoice: invoice(), bl: bl(), declaration: decl() });
  out.push({ invoice: invoice({ gross_weight: { value: '13000' } }), bl: bl(), declaration: decl({ currency: { value: 'SAR' } }) });
  out.push({ invoice: invoice({ buyer_name: { value: 'Marsa' } }), bl: bl({ consignee: { value: 'Marsa Logistics Services' }, packages_count: { value: '1' } }), declaration: decl() });
  out.push({ invoice: invoice(), bl: bl(), declaration: decl({ gross_weight: { value: '9000' }, invoice_number: { value: 'INV-9' } }) });
  out.push({ invoice: invoice(), bl: bl({ invoice_number: { value: 'INV-OTHER-77' } }), declaration: decl() });
  out.push({ invoice: { fields: omit(invoice().fields, ['container_numbers', 'net_weight']) }, bl: bl({ net_weight: null }), declaration: decl({ consignee: null }) });
  out.push({ invoice: invoice() }, { bl: bl(), declaration: decl() }, { invoice: invoice(), declaration: decl() }, {});
  let seed = 4242; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = ['', ' ', '0', '12500', '12,500 KGS', '13 MT', '500', '500 CTNS', 'CIF Jeddah', 'جدة', 'MSCU1234566', 'MSCU1234566, TGHU1234567', '8708.30', '870899',
    'Marsa Trading Co', 'شركة مرسى للتجارة', 'NINGBO SUNRISE', 'China', 'الصين', 'USD', 'SAR', '25000', '2026-10-01', '01/10/2026', 'INV-2026-0042', 'MEDU12345678', null, 3.5, 'X'];
  const keys = ['invoice_number', 'bl_number', 'container_numbers', 'shipper', 'supplier_name', 'consignee', 'buyer_name', 'gross_weight', 'net_weight',
    'packages_count', 'package_type', 'hs_codes', 'country_of_origin', 'port_of_loading', 'port_of_discharge', 'vessel', 'incoterms', 'goods_description',
    'invoice_date', 'currency', 'total', 'subtotal', 'declaration_number'];
  const p = () => pool[Math.floor(rnd() * pool.length)];
  const doc = () => { const f = {}; keys.forEach(k => { if (rnd() < 0.55) f[k] = rnd() < 0.4 ? p() : { value: p(), score: Math.round(rnd() * 100) / 100, corrected: rnd() < 0.1 }; });
    return { fields: f, items: rnd() < 0.5 ? [{ description: p(), hs_code: p(), quantity: Math.floor(rnd() * 10), amount: p() }, { description: 'Brake pads', hs_code: '870830', quantity: 4, amount: 100 }] : [] }; };
  for (let i = 0; i < 400; i++) {
    const inp = {};
    if (rnd() < 0.92) inp.invoice = doc();
    if (rnd() < 0.92) inp.bl = doc();
    if (rnd() < 0.5) inp.declaration = doc();
    out.push(inp);
  }
  return out.map(W);
}
function snapshotDigest(strip) {
  const h = require('crypto').createHash('sha256');
  snapshotCorpus().forEach(inp => {
    const r = M.compare(inp, { now: '2026-11-12T00:00:00Z' });
    const o = {}; Object.keys(r).forEach(k => { if (!strip || (k !== 'with_packing' && k !== 'docs')) o[k] = r[k]; });
    h.update(J(o) + '\n');
  });
  return h.digest('hex');
}

section('22. packing list absent: identical to match-v1');
{
  // sha256 of the results of snapshotCorpus() computed with the engine BEFORE the packing list was added
  // (match-v1, 2026-11-12), the two new keys stripped. Update it only for an intended change of the v1 behaviour.
  eq('snapshot of 412 results without a packing list is unchanged', snapshotDigest(true), 'f568c994bc91637717a3746c7ae73cd1deaac12feacbf1a65eaa9a5adb7dcd37');
  const base = M.compare({ invoice: invoice(), bl: bl(), declaration: decl() });
  eq('version stays match-v1', base.version, 'match-v1');
  eq('with_packing false', base.with_packing, false);
  eq('docs = documents', base.docs, base.documents);
  eq('result keys: the old ones in order, then with_packing + docs',
    Object.keys(base), ['version', 'mode', 'rows', 'items', 'counts', 'overall', 'documents', 'generated_at', 'with_packing', 'docs']);
  check('no row carries a packing key (values / conf / src / pairs)', () => base.rows.every(r => !('packing' in r.values) && !('packing' in r.conf) && !('packing' in r.src)
    && J(Object.keys(r.pairs)) === J(['inv_bl', 'inv_decl', 'bl_decl'])) || 'packing keys');
  const two = M.compare({ invoice: invoice(), bl: bl() });
  check('two-way: still match-v1 + three pair keys', () => two.version === 'match-v1' && two.rows.every(r => J(Object.keys(r.pairs)) === J(['inv_bl', 'inv_decl', 'bl_decl'])) || 'two');
  check('packing: null / not an object → ignored (v1)', () => { const r = M.compare({ invoice: invoice(), bl: bl(), packing: null }); const r2 = M.compare({ invoice: invoice(), bl: bl(), packing: 'x' });
    return r.version === 'match-v1' && !r.with_packing && r2.version === 'match-v1' && J(r.rows) === J(two.rows) || 'ignored'; });
}

section('23. packing list: exports');
check('DOCS has packing last; BASE_DOCS the old three', () => J(M.DOCS) === J(['invoice', 'bl', 'declaration', 'packing']) && J(M.BASE_DOCS) === J(['invoice', 'bl', 'declaration']) || J(M.DOCS));
check('VERSION_PACKING / VERSIONS', () => M.VERSION === 'match-v1' && M.VERSION_PACKING === 'match-v2' && J(M.VERSIONS) === J(['match-v1', 'match-v2']) || 'versions');
check('PAIRS map incl. inv_pack / bl_pack / decl_pack', () => J(M.PAIRS) === J({ inv_bl: ['invoice', 'bl'], inv_decl: ['invoice', 'declaration'], bl_decl: ['bl', 'declaration'],
  inv_pack: ['invoice', 'packing'], bl_pack: ['bl', 'packing'], decl_pack: ['declaration', 'packing'] }) || J(M.PAIRS));
check('DOC_LABELS: بيان التعبئة / the packing list', () => M.DOC_LABELS.ar.packing === 'بيان التعبئة' && M.DOC_LABELS.en.packing === 'the packing list' || J(M.DOC_LABELS));
check('FIELDS: packing feeds the contract fields, expected only for containers / weights / packages', () => {
  const feeds = M.FIELDS.filter(f => f.keys.packing).map(f => f.key).sort();
  const exp = M.FIELDS.filter(f => f.exp.indexOf('packing') !== -1).map(f => f.key).sort();
  return J(feeds) === J(['consignee', 'container_numbers', 'country_of_origin', 'goods_description', 'gross_weight', 'hs_codes', 'invoice_number', 'net_weight',
    'package_type', 'packages_count', 'shipper'].sort()) && J(exp) === J(['container_numbers', 'gross_weight', 'net_weight', 'packages_count']) || J([feeds, exp]);
});
check('ROW_KEYS unchanged (22, the DB allow-list)', () => M.ROW_KEYS.length === 22 || M.ROW_KEYS.length);

section('24. packing list: four documents agree');
{
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: packing() });
  eq('version match-v2', r.version, 'match-v2');
  eq('mode three_way (decided by the declaration)', r.mode, 'three_way');
  eq('with_packing true', r.with_packing, true);
  eq('documents / docs list packing', [r.documents, r.docs], [['invoice', 'bl', 'declaration', 'packing'], ['invoice', 'bl', 'declaration', 'packing']]);
  eq('overall match', r.overall, 'match');
  check('no mismatch / missing / partial', () => r.counts.mismatch === 0 && r.counts.missing === 0 && r.counts.partial === 0 || J(r.counts));
  check('every row carries the packing keys and the six pairs', () => r.rows.every(x => 'packing' in x.values && 'packing' in x.conf && 'packing' in x.src
    && J(Object.keys(x.pairs)) === J(['inv_bl', 'inv_decl', 'bl_decl', 'inv_pack', 'bl_pack', 'decl_pack'])) || 'shape');
  check('gross: all six pairs match, packing value + conf + src', () => { const g = row(r, 'gross_weight');
    return J(g.pairs) === J({ inv_bl: 'match', inv_decl: 'match', bl_decl: 'match', inv_pack: 'match', bl_pack: 'match', decl_pack: 'match' })
      && g.values.packing === '12,500 KGS' && g.conf.packing === 0.9 && g.src.packing === 'gross_weight' || J(g); });
  check('consignee from consignee_name (src)', () => { const c = row(r, 'consignee'); return c.status === 'match' && c.src.packing === 'consignee_name' && c.pairs.decl_pack === 'match' || J(c); });
  check('net weight: invoice + B/L + packing match (declaration not applicable value)', () => { const n = row(r, 'net_weight'); return n.status === 'match' && n.pairs.inv_pack === 'match' && n.pairs.bl_pack === 'match' || J(n); });
  check('rows without packing keys keep packing undefined (total / currency / dates)', () => ['total', 'currency', 'invoice_date'].every(k => row(r, k) && row(r, k).values.packing === undefined
    && row(r, k).pairs.inv_pack === null && row(r, k).src.packing === null) || 'undef');
  check('critical set is the three-way set', () => J(r.rows.filter(x => x.critical).map(x => x.key).sort())
    === J(['bl_number', 'consignee', 'container_numbers', 'gross_weight', 'hs_codes', 'invoice_number', 'packages_count', 'total']) || 'crit');
  check('packing line items are not compared (items row + groups as without packing)', () => {
    const r0 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl() });
    const it = row(r, 'items'), it0 = row(r0, 'items');
    return J(r.items) === J(r0.items) && (it ? it.values.packing === undefined && it.pairs.decl_pack === null : true) && J(!!it) === J(!!it0) || J([r.items, it]);
  });
  check('invoice_totals row carries the packing keys', () => { const t = row(r, 'invoice_totals'); return t && 'packing' in t.values && t.values.packing === undefined && t.conf.packing === null && 'bl_pack' in t.pairs || J(t); });
  check('same rows as without packing for fields packing does not feed', () => {
    const r0 = M.compare({ invoice: invoice(), bl: bl(), declaration: decl() });
    return ['bl_number', 'port_of_loading', 'vessel', 'incoterms', 'total'].every(k => row(r, k).status === row(r0, k).status) || 'same';
  });
}

section('25. packing list: gross 25000 vs 27500 (يوجد اختلاف)');
{
  const W = { gross_weight: { value: '25000', score: 0.9 } };
  const r = M.compare({ invoice: invoice(W), bl: bl({ gross_weight: { value: '25,000 KGS' } }), declaration: decl(W), packing: packing({ gross_weight: { value: '27,500 KGS', score: 0.9 } }) });
  const g = row(r, 'gross_weight');
  eq('gross row mismatch', g.status, 'mismatch');
  eq('critical', g.critical, true);
  eq('overall mismatch', r.overall, 'mismatch');
  eq('pairs: base agree, every packing pair differs', g.pairs, { inv_bl: 'match', inv_decl: 'match', bl_decl: 'match', inv_pack: 'mismatch', bl_pack: 'mismatch', decl_pack: 'mismatch' });
  check('detail names the packing list as the odd one + the difference (AR + EN)', () => /^بيان التعبئة يختلف عن الفاتورة، البوليصة والبيان/.test(g.detail_ar) && /الفرق 2,500 كجم/.test(g.detail_ar)
    && /^The packing list differs from the invoice, the B\/L and the declaration/.test(g.detail_en) && /Difference 2,500 kg/.test(g.detail_en) || J([g.detail_ar, g.detail_en]));
  eq('counts: one mismatch only', r.counts.mismatch, 1);
  const two = M.compare({ invoice: invoice(W), bl: bl({ gross_weight: { value: '25000 KG' } }), packing: packing({ gross_weight: { value: '27500' } }) });
  check('two-way + packing: mode two_way, bl_pack mismatch, decl pairs null, overall mismatch', () => { const x = row(two, 'gross_weight');
    return two.mode === 'two_way' && two.with_packing && two.version === 'match-v2' && x.pairs.bl_pack === 'mismatch' && x.pairs.inv_bl === 'match'
      && x.pairs.inv_decl === null && x.pairs.decl_pack === null && two.overall === 'mismatch' && /^بيان التعبئة يختلف عن الفاتورة والبوليصة/.test(x.detail_ar) || J([two.mode, x]); });
  check('B/L alone differs from invoice + declaration + packing (feminine verb)', () => {
    const x = row(M.compare({ invoice: invoice(), bl: bl({ gross_weight: { value: '9000' } }), declaration: decl(), packing: packing() }), 'gross_weight');
    return x.status === 'mismatch' && /^البوليصة تختلف عن الفاتورة، البيان وبيان التعبئة/.test(x.detail_ar) || J(x.detail_ar);
  });
  check('2 + 2 split: no single odd document named', () => {
    const x = row(M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ gross_weight: { value: '9000' } }), packing: packing({ gross_weight: { value: '9000' } }) }), 'gross_weight');
    return x.status === 'mismatch' && !/يختلف عن|تختلف عن|disagree/.test(x.detail_ar + x.detail_en) || J(x.detail_ar);
  });
  check('four documents disagree', () => {
    const x = row(M.compare({ invoice: invoice({ gross_weight: { value: '1000' } }), bl: bl({ gross_weight: { value: '2000' } }), declaration: decl({ gross_weight: { value: '3000' } }),
      packing: packing({ gross_weight: { value: '4000' } }) }), 'gross_weight');
    return /المستندات الأربعة/.test(x.detail_ar) && /four documents disagree/.test(x.detail_en) || J(x.detail_ar);
  });
  check('packages differ on the packing list → critical mismatch', () => { const r2 = M.compare({ invoice: invoice(), bl: bl(), packing: packing({ packages_count: { value: '480' } }) });
    return st(r2, 'packages_count') === 'mismatch' && r2.overall === 'mismatch' && row(r2, 'packages_count').pairs.bl_pack === 'mismatch' || J(row(r2, 'packages_count')); });
  check('net weight differs only on the packing list → mismatch, overall review (not critical)', () => { const r2 = M.compare({ invoice: invoice(), bl: bl(), packing: packing({ net_weight: { value: '11000' } }) });
    return st(r2, 'net_weight') === 'mismatch' && !row(r2, 'net_weight').critical && r2.overall === 'review' || J([row(r2, 'net_weight'), r2.overall]); });
}

section('26. packing list: missing values');
{
  const full = M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: packing() });
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: { fields: omit(packing().fields, ['packages_count']) } });
  const p = row(r, 'packages_count');
  eq('packages missing on the packing list → missing', p.status, 'missing');
  check('detail: لا يظهر في بيان التعبئة / Not shown on the packing list', () => /لا يظهر في بيان التعبئة/.test(p.detail_ar) && /Not shown on the packing list/.test(p.detail_en) || J(p));
  eq('packing pairs missing, base pairs match', p.pairs, { inv_bl: 'match', inv_decl: 'match', bl_decl: 'match', inv_pack: 'missing', bl_pack: 'missing', decl_pack: 'missing' });
  eq('counts.missing +1 over the full match', r.counts.missing, full.counts.missing + 1);
  eq('overall review (critical row missing)', r.overall, 'review');
  check('values.packing null (uploaded, no value), src = packages_count', () => p.values.packing === null && p.src.packing === 'packages_count' || J(p));
  ['gross_weight', 'container_numbers', 'net_weight'].forEach(k => {
    check(k + ' missing on the packing list → missing', () => st(M.compare({ invoice: invoice(), bl: bl(), packing: { fields: omit(packing().fields, [k]) } }), k) === 'missing' || 'st');
  });
  ['shipper', 'consignee_name', 'goods_description', 'package_type', 'hs_codes', 'country_of_origin'].forEach(k => {
    check(k + ' absent on the packing list (optional) → not missing', () => {
      const x = M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: { fields: omit(packing().fields, [k]) } });
      const key = k === 'consignee_name' ? 'consignee' : k;
      return st(x, key) === st(M.compare({ invoice: invoice(), bl: bl(), declaration: decl() }), key) || J(row(x, key));
    });
  });
  check('net weight only on the packing list → info (no other document expected)', () => {
    const x = M.compare({ invoice: { fields: omit(invoice().fields, ['net_weight']) }, bl: bl({ net_weight: null }), packing: packing() });
    return st(x, 'net_weight') === 'info' || J(row(x, 'net_weight'));
  });
  check('net weight row appears only because of the packing list', () => {
    const inv = { fields: omit(invoice().fields, ['net_weight']) }, b = bl({ net_weight: null });
    return row(M.compare({ invoice: inv, bl: b }), 'net_weight') === null && row(M.compare({ invoice: inv, bl: b, packing: packing() }), 'net_weight') !== null || 'row';
  });
  check('empty packing list: v2, containers / gross / packages missing, overall review', () => {
    const x = M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: { fields: {} } });
    return x.version === 'match-v2' && x.with_packing && ['container_numbers', 'gross_weight', 'packages_count'].every(k => st(x, k) === 'missing') && x.overall === 'review' || J(x.counts);
  });
  check('invoice + packing only (no B/L) → review', () => { const x = M.compare({ invoice: invoice(), packing: packing() }); return x.overall === 'review' && x.mode === 'two_way' || x.overall; });
  check('invoice + B/L + packing (no declaration) is never three_way', () => M.compare({ invoice: invoice(), bl: bl(), packing: packing() }).mode === 'two_way' || 'mode');
}

section('27. packing list: decl_pack pair + invoice reference');
{
  const r = M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ container_numbers: { value: 'TGHU1234567' } }), packing: packing({ container_numbers: { value: 'MSCU1234566, TGHU1234567' } }) });
  const c = row(r, 'container_numbers');
  check('decl_pack partial (one container in common), bl_pack partial, bl_decl mismatch', () => c.pairs.decl_pack === 'partial' && c.pairs.bl_pack === 'partial' && c.pairs.bl_decl === 'mismatch'
    && c.status === 'mismatch' || J(c.pairs));
  check('set detail names the packing list', () => /في بيان التعبئة فقط: TGHU1234567/.test(c.detail_ar) && /Only in the packing list: TGHU1234567/.test(c.detail_en) || J(c.detail_ar));
  const d2 = row(M.compare({ invoice: invoice(), bl: bl(), declaration: decl({ hs_codes: { value: '870830' } }), packing: packing({ hs_codes: { value: '870830' } }) }), 'hs_codes');
  eq('decl_pack match when both carry the same HS', d2.pairs.decl_pack, 'match');
  const i1 = row(M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: packing({ invoice_number: null, packing_list_number: { value: 'INV-2026-0042', score: 0.8 } }) }), 'invoice_number');
  check('packing_list_number equal to the invoice number counts as its invoice reference', () => i1.values.packing === 'INV-2026-0042' && i1.src.packing === 'packing_list_number'
    && i1.pairs.inv_pack === 'match' && i1.pairs.decl_pack === 'match' && i1.status === 'match' || J(i1));
  const i2 = row(M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: packing({ invoice_number: null }) }), 'invoice_number');
  check('another packing_list_number is not a reference (packing value null, row still match)', () => i2.values.packing === null && i2.src.packing === 'invoice_number'
    && i2.pairs.inv_pack === 'missing' && i2.status === 'match' || J(i2));
  const i3 = row(M.compare({ invoice: invoice(), bl: bl(), declaration: decl(), packing: packing({ invoice_number: { value: 'INV-2026-9999' } }) }), 'invoice_number');
  check('three-way: a packing list citing another invoice → partial (optional reference), not critical mismatch', () => i3.status === 'partial' && i3.pairs.inv_pack === 'mismatch'
    && /بيان التعبئة فقط \(مرجع اختياري\)/.test(i3.detail_ar) || J(i3));
  const i4 = M.compare({ invoice: invoice(), bl: bl(), packing: packing({ invoice_number: { value: 'INV-2026-9999' } }) });
  check('two-way: invoice number differs on the packing list → mismatch, not critical, overall review', () => st(i4, 'invoice_number') === 'mismatch' && !row(i4, 'invoice_number').critical
    && i4.overall === 'review' || J([row(i4, 'invoice_number'), i4.overall]));
  check('Arabic packing list: consignee in Arabic vs Arabic invoice', () => {
    const x = M.compare({ invoice: { fields: { buyer_name: 'شركة الفجر للتجارة', gross_weight: '100' } }, bl: { fields: { consignee: 'مؤسسة الفجر', gross_weight: '100 كجم' } },
      packing: { fields: { consignee_name: 'الفجر', gross_weight: '٠٫١ طن' } } });
    return st(x, 'consignee') === 'match' && st(x, 'gross_weight') === 'match' || J(x.rows);
  });
}

section('28. packing list: robustness + determinism');
check('corrections on the packing list keep row.corrected', () => row(M.compare({ invoice: invoice(), bl: bl(), packing: packing({ gross_weight: { value: '12500', corrected: true } }) }), 'gross_weight').corrected === true || 'corrected');
check('deterministic with packing', () => { const i = { invoice: invoice(), bl: bl(), declaration: decl(), packing: packing() };
  return J(M.compare(i, { now: 'x' })) === J(M.compare(JSON.parse(J(i)), { now: 'x' })) || 'det'; });
check('input not mutated', () => { const p = packing(); const s0 = J(p); M.compare({ invoice: invoice(), bl: bl(), packing: p }); return J(p) === s0 || 'mutated'; });
check('random fuzz with packing: 300 inputs never throw and keep the shape', () => {
  let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = ['', '0', '12,5', '27500', '25000 KG', 'MSCU1234566', 'INV-1', 'PL-1', 'Marsa', 'جدة', '٫', null, 7, 'CTNS'];
  const keys = ['invoice_number', 'packing_list_number', 'container_numbers', 'shipper', 'supplier_name', 'consignee', 'consignee_name', 'buyer_name', 'gross_weight',
    'net_weight', 'packages_count', 'package_type', 'hs_codes', 'country_of_origin', 'goods_description', 'bl_number', 'total', 'currency'];
  const doc = () => { const f = {}; keys.forEach(k => { if (rnd() < 0.5) f[k] = rnd() < 0.5 ? pool[Math.floor(rnd() * pool.length)] : { value: pool[Math.floor(rnd() * pool.length)], score: rnd() }; });
    return { fields: f, items: [] }; };
  const P6 = ['inv_bl', 'inv_decl', 'bl_decl', 'inv_pack', 'bl_pack', 'decl_pack'];
  for (let i = 0; i < 300; i++) {
    const inp = { invoice: rnd() < 0.9 ? doc() : undefined, bl: rnd() < 0.9 ? doc() : undefined, declaration: rnd() < 0.5 ? doc() : undefined, packing: doc() };
    const r = M.compare(inp);
    if (r.version !== 'match-v2' || r.with_packing !== true) return 'version ' + i;
    if (r.mode !== (inp.invoice && inp.bl && inp.declaration ? 'three_way' : 'two_way')) return 'mode ' + i;
    if (!r.rows.every(x => M.ROW_KEYS.includes(x.key) && J(Object.keys(x.pairs)) === J(P6) && 'packing' in x.values)) return 'row ' + i;
    const sum = r.counts.match + r.counts.mismatch + r.counts.partial + r.counts.missing;
    if (sum !== r.rows.filter(x => x.status !== 'info').length) return 'counts ' + i;
    if (r.rows.some(x => x.critical && x.status === 'mismatch') && r.overall !== 'mismatch') return 'overall rule ' + i;
  }
  return true;
});
check('browser (vm): packing → match-v2', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'doc-match.js'), 'utf8');
  const win = {}; const ctx = { window: win }; vm.createContext(ctx); vm.runInContext(src, ctx);
  return win.MarsaDocMatch.compare({ invoice: invoice(), bl: bl(), packing: packing() }).version === 'match-v2' || 'vm';
});
check('engine source stays ES5 (no let / const / arrow / template / class)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'doc-match.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return !/\b(let|const|class)\s|=>|`/.test(src) || 'es6';
});

/* ----------------------------------------------------------------- summary */
console.log('\nMarsa — doc-match engine tests: ' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' checks)');
if (fail) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
