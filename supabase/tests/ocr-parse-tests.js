/* =====================================================================
   Marsa — ocr-parse.js text parser tests (fields v2: bill-of-lading / shipping data)
   Pure Node, no DB. All texts are SYNTHETIC (invented companies, numbers).
   Run: node supabase/tests/ocr-parse-tests.js <repo root> [--quiet]
   ===================================================================== */
'use strict';
const path = require('path');
const ROOT = path.resolve(process.argv[2] && !/^--/.test(process.argv[2]) ? process.argv[2] : path.join(__dirname, '..', '..'));
const QUIET = process.argv.indexOf('--quiet') !== -1;
const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw ' + (e && e.stack || e); }
  if (r === true) { pass++; if (!QUIET) console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (r === false || r == null ? '' : ' — ' + r)); }
}
function section(t) { console.log('\n== ' + t); }
const J = JSON.stringify;
function plain(text, type) { return P.plainFields(P.extractFields(text, type).fields); }
function expect(got, want) {
  const bad = Object.keys(want).filter(k => got[k] !== want[k]);
  return bad.length === 0 || bad.map(k => k + ': got ' + J(got[k]) + ' want ' + J(want[k])).join('; ');
}

console.log('Marsa — ocr-parse.js tests (synthetic texts, no DB)');

/* --- 1. B/L with column gaps (Tesseract preserve_interword_spaces) --- */
section('1. bill of lading — block labels + label rows (column gaps)');
const BL = [
  'BILL OF LADING',
  'Shipper                                          B/L No: SYNBL0426X1',
  'NORTHWIND TEXTILE EXPORT LTD.',
  '12 SAMPLE STREET, IZMIR, TURKEY',
  '',
  'Consignee',
  'ALPHA MEDICAL TRADING CO.',
  'P.O. BOX 0000, JEDDAH, SAUDI ARABIA',
  'Notify address',
  'SAME AS CONSIGNEE',
  'Ocean Vessel / Voyage        Port of loading',
  'MV PAPU / PAP0426E           ALIAGA NEMPORT',
  'Port of discharge            Place of delivery',
  'JEDDAH                       JEDDAH',
  'Container No / Seal No       No. of packages     Description of goods          Gross weight, Kgs',
  'MSCU1234566 / 998877         19 PALLETS          MEDICAL GAUZE DRESSINGS       4.040,000 Kgs',
  'HS CODE: 300590500019 902110100019',
  'FREIGHT PREPAID'
].join('\n');
const bl = plain(BL, 'bill_of_lading');
check('shipper / consignee from the block labels (first value line = the name)', () =>
  expect(bl, { shipper: 'NORTHWIND TEXTILE EXPORT LTD.', consignee: 'ALPHA MEDICAL TRADING CO.' }));
check('vessel / voyage split from "MV PAPU / PAP0426E"; ports by column order', () =>
  expect(bl, { vessel: 'MV PAPU', voyage: 'PAP0426E', port_of_loading: 'ALIAGA NEMPORT', port_of_discharge: 'JEDDAH' }));
check('packages "19 PALLETS", goods, gross "4.040,000 Kgs" → 4040 (European decimal)', () =>
  expect(bl, { packages_count: '19', package_type: 'PALLETS', goods_description: 'MEDICAL GAUZE DRESSINGS', gross_weight: '4040' }));
check('B/L number, container (ISO 6346 valid), HS list', () =>
  expect(bl, { bl_number: 'SYNBL0426X1', container_numbers: 'MSCU1234566', hs_codes: '300590500019, 902110100019' }));
check('B/L: supplier_name / buyer_name follow shipper / consignee (not the "B/L No" label)', () =>
  expect(bl, { supplier_name: 'NORTHWIND TEXTILE EXPORT LTD.', buyer_name: 'ALPHA MEDICAL TRADING CO.' }));
check('only known field keys are produced, every value has the F() shape', () => {
  const f = P.extractFields(BL, 'bill_of_lading').fields;
  const bad = Object.keys(f).filter(k => P.FIELD_KEYS.indexOf(k) === -1 || typeof f[k].value !== 'string'
    || ['high', 'medium', 'low'].indexOf(f[k].confidence) === -1 || f[k].source !== 'text');
  return bad.length === 0 || bad.join(', ');
});
check('the same B/L read as a commercial invoice still fills the shipping fields', () => {
  const x = plain(BL, 'commercial_invoice');
  return expect(x, { vessel: 'MV PAPU', voyage: 'PAP0426E', port_of_loading: 'ALIAGA NEMPORT', gross_weight: '4040', packages_count: '19', shipper: 'NORTHWIND TEXTILE EXPORT LTD.' });
});

/* --- 2. B/L read without the column gaps (single spaces) / inline labels --- */
section('2. bill of lading — inline labels, collapsed spaces, MT weights');
const BL2 = [
  'Shipper: SYNTH EXPORTS LLC',
  'Consignee: TO ORDER OF SAMPLE BANK',
  'Vessel: MSC SYNTHIA',
  'Voyage No: 612W',
  'Port of Loading: NINGBO, CHINA',
  'Port of Discharge: DAMMAM',
  'Gross Weight: 18.25 MT',
  'Net Weight: 17,900 KGS',
  'Total packages: 1,200 CARTONS',
  'SAID TO CONTAIN: PLASTIC HOUSEWARE'
].join('\n');
const b2 = plain(BL2, 'bill_of_lading');
check('inline "Label: value" rows', () =>
  expect(b2, { shipper: 'SYNTH EXPORTS LLC', vessel: 'MSC SYNTHIA', voyage: '612W', port_of_loading: 'NINGBO, CHINA', port_of_discharge: 'DAMMAM' }));
check('18.25 MT → 18250 kg; "17,900 KGS" → 17900; "1,200 CARTONS"', () =>
  expect(b2, { gross_weight: '18250', net_weight: '17900', packages_count: '1200', package_type: 'CARTONS' }));
check('"SAID TO CONTAIN" → goods description (low confidence)', () => {
  const f = P.extractFields(BL2, 'bill_of_lading').fields;
  return (f.goods_description && f.goods_description.value === 'PLASTIC HOUSEWARE' && f.goods_description.confidence === 'low') || J(f.goods_description);
});
const BL3 = ['Ocean Vessel / Voyage Port of loading', 'MV PAPU / PAP0426E ALIAGA NEMPORT'].join('\n');
check('collapsed label row: vessel + voyage still split (voyage is one token)', () => {
  const x = plain(BL3, 'bill_of_lading');
  return (x.vessel === 'MV PAPU' && x.voyage === 'PAP0426E') || J(x);
});
check('a label word inside running text is not a label ("… the vessel …")', () => {
  const x = plain('We confirm the vessel arrived late due to weather conditions at sea.', 'bill_of_lading');
  return !x.vessel || J(x);
});

/* --- 3. Commercial invoice --- */
section('3. commercial invoice — Incoterms / origin / packages');
const INV = [
  'COMMERCIAL INVOICE',
  'Invoice No: INV-2026-0042        Date: 12/10/2026',
  'Exporter: NORTHWIND TEXTILE EXPORT LTD.',
  'Consignee: ALPHA MEDICAL TRADING CO.',
  'Incoterms : EXW',
  'Country of Origin : TURKEY',
  'Total packages: 2500 CARTONS',
  'Net weight: 3.800,500 Kgs',
  'Currency: USD',
  'Grand Total 12,500.00'
].join('\n');
const inv = plain(INV, 'commercial_invoice');
check('"Incoterms : EXW", "Country of Origin : TURKEY" (→ تركيا)', () => expect(inv, { incoterms: 'EXW', country_of_origin: 'تركيا' }));
check('"2500 CARTONS", net "3.800,500 Kgs" → 3800.5', () => expect(inv, { packages_count: '2500', package_type: 'CARTONS', net_weight: '3800.5' }));
check('existing invoice fields unchanged (number, date, supplier, currency, total)', () =>
  expect(inv, { invoice_number: 'INV-2026-0042', invoice_date: '2026-10-12', supplier_name: 'NORTHWIND TEXTILE EXPORT LTD.', currency: 'USD', total: '12500.00' }));
check('"CIF JEDDAH" without a label → incoterms (low)', () => {
  const f = P.extractFields('Price terms CIF JEDDAH\nTotal 100.00', 'commercial_invoice').fields;
  return (f.incoterms && f.incoterms.value === 'CIF JEDDAH' && f.incoterms.confidence === 'low') || J(f.incoterms);
});
check('"Terms of delivery: FOB Shanghai" → FOB SHANGHAI', () => {
  const x = plain('Terms of delivery: FOB Shanghai', 'commercial_invoice');
  return x.incoterms === 'FOB SHANGHAI' || J(x);
});

/* --- 4. Saudi tax invoice: the shipping pass adds nothing it should not --- */
section('4. Saudi VAT invoice regression');
const TAX = [
  'فاتورة ضريبية',
  'رقم الفاتورة: 10045',
  'تاريخ الفاتورة: 2026-10-01',
  'اسم المورد: مؤسسة اختبار للتجارة',
  'الرقم الضريبي: 300000000000003',
  'المجموع قبل الضريبة 1,000.00',
  'ضريبة القيمة المضافة 150.00',
  'الإجمالي شامل الضريبة 1,150.00',
  '1 قطعة غيار 10 100.00 1000.00'
].join('\n');
const tax = plain(TAX, 'operator_invoice');
check('VAT invoice fields as before', () =>
  expect(tax, { invoice_number: '10045', invoice_date: '2026-10-01', supplier_vat: '300000000000003', subtotal: '1000.00', vat_amount: '150.00', total: '1150.00' }));
check('no shipping keys invented on a plain VAT invoice', () => {
  const extra = ['shipper', 'consignee', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'gross_weight', 'net_weight', 'packages_count', 'package_type', 'goods_description', 'incoterms']
    .filter(k => tax[k]);
  return extra.length === 0 || extra.map(k => k + '=' + tax[k]).join(', ');
});
check('empty / null text', () => J(P.extractFields('', 'bill_of_lading').fields) === '{}' && J(P.extractFields(null).fields) === '{}');

/* --- 5. numbers of unrelated labels are not weights / packages (scanned B/L, owner report 2026-11-12) --- */
section('5. "Number of original Bs/L 3", "Freight payable at", page numbers → never a weight or a package count');
const BL5 = [
  'BILL OF LADING                                   B/L No: SYNBL0777Z',
  'Shipper',
  'SAMPLE EXPORT INDUSTRIES CO.',
  '',
  'Consignee',
  'BETA TRADING EST.',
  'Freight payable at              Number of original Bs/L 3',
  'DESTINATION',
  'Number of original Bs/L         Gross Weight',
  '3',
  'Gross Weight (KGS)              Number of original Bs/L',
  '                                3',
  'No. of packages                 Number of original Bs/L',
  '                                3',
  'Page 1 of 2'
].join('\n');
const b5 = plain(BL5, 'bill_of_lading');
check('the B/L label row "Freight payable at  Number of original Bs/L 3": no gross weight, no packages, no package type, no "origin"', () =>
  (!b5.gross_weight && !b5.net_weight && !b5.packages_count && !b5.package_type && !b5.country_of_origin) || J(b5));
check('the same B/L still reads its B/L number / shipper / consignee', () =>
  expect(b5, { bl_number: 'SYNBL0777Z', shipper: 'SAMPLE EXPORT INDUSTRIES CO.', consignee: 'BETA TRADING EST.' }));
check('"Number of original Bs/L  Gross Weight" / "3  18,250 KGS" → the weight of its own column (18250)', () => {
  const x = plain(['Number of original Bs/L     Gross Weight', '3                           18,250 KGS'].join('\n'), 'bill_of_lading');
  return x.gross_weight === '18250' || J(x);
});
check('a bare number under the weight label column is a weight ("Gross weight" / "18250")', () => {
  const x = plain(['Gross weight', '18250'].join('\n'), 'bill_of_lading');
  return x.gross_weight === '18250' || J(x);
});
check('"Gross weight" / "Page 1 of 3" and "Gross weight  3 ORIGINALS" are not weights', () => {
  const a = plain(['Gross weight', 'Page 1 of 3'].join('\n'), 'bill_of_lading');
  const b = plain('Gross weight  3 ORIGINALS', 'bill_of_lading');
  const c = plain('Gross wt: 3 originals issued', 'bill_of_lading');
  return (!a.gross_weight && !b.gross_weight && !c.gross_weight && !b.country_of_origin && !c.country_of_origin) || J({ a, b, c });
});
check('inline weights with a unit still read ("Gross weight (in KGS): 18,250.500", "G.W. 4.040,000 Kgs")', () => {
  const a = plain('Gross weight (in KGS): 18,250.500', 'commercial_invoice');
  const b = plain('Remarks  G.W. 4.040,000 Kgs', 'commercial_invoice');
  return (a.gross_weight === '18250.5' && b.gross_weight === '4040') || J({ a, b });
});
check('"No. of packages" / "1 of 2" (a page number) and "2/3" are not package counts', () => {
  const a = plain(['No. of packages', '1 of 2'].join('\n'), 'bill_of_lading');
  const b = plain(['Total packages', '2/3'].join('\n'), 'bill_of_lading');
  return (!a.packages_count && !b.packages_count) || J({ a, b });
});
check('"Origin: TURKEY" is still the country of origin (the "original" guard is a word boundary only)', () => {
  const x = plain('Origin: TURKEY', 'commercial_invoice');
  return x.country_of_origin === 'تركيا' || J(x);
});
check('plainFields(fields, DB_FIELD_KEYS) keeps the ai-doc-v3 keys; the default keeps FIELD_KEYS only', () => {
  const f = { seal_numbers: { value: 'SL1' }, notify_party: { value: 'N' }, vessel: { value: 'V' }, secret: { value: 'x' } };
  const all = P.plainFields(f, P.DB_FIELD_KEYS), def = P.plainFields(f);
  return (J(all) === J({ seal_numbers: 'SL1', notify_party: 'N', vessel: 'V' }) && J(def) === J({ vessel: 'V' })
    && P.FIELD_KEYS.every(k => P.DB_FIELD_KEYS.includes(k)) && P.DB_FIELD_KEYS.length === P.FIELD_KEYS.length + 22) || J({ all, def });
});

console.log('\n' + '-'.repeat(70));
console.log((fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
