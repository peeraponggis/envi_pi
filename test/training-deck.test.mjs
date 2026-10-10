// ตรวจไฟล์นำเสนอสำหรับการอบรม วสท. 30 ต.ค. 2569
// เงื่อนไขหลักคือ "ไฟล์เดียวเปิดได้ออฟไลน์" และ "ทุกตัวเลขสืบที่มาได้"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aerationEnergy, solarOption, epcOffer, ppaOffer } from '../web/js/sensor-catalog.js';

const FILE = new URL('../web/training-ai-netzero-2569.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const src = readFileSync(FILE, 'utf8');
const slides = [...src.matchAll(/<section class="slide[^"]*"([^>]*)>/g)].map((m) => m[1]);

test('ทุกสไลด์มีหมวด ชื่อ และเวลาในกำหนดการ', () => {
  assert.ok(slides.length >= 60, 'ควรมีสไลด์อย่างน้อย 60 แผ่น ได้ ' + slides.length);
  for (const [i, a] of slides.entries()) {
    assert.match(a, /data-sec="/, `สไลด์ที่ ${i + 1} ไม่มี data-sec`);
    assert.match(a, /data-title="/, `สไลด์ที่ ${i + 1} ไม่มี data-title`);
    assert.match(a, /data-min="/, `สไลด์ที่ ${i + 1} ไม่มี data-min`);
  }
});

test('เวลารวมในกำหนดการตรงกับโครงการหนึ่งวัน', () => {
  const total = [...src.matchAll(/data-min="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
  // 08.30–16.30 คือ 480 นาที หักลงทะเบียน 30 นาทีที่เป็นสไลด์ค้างไว้ → เนื้อหาและพักรวมราว 420–470
  assert.ok(total >= 400 && total <= 470, 'เวลารวมควรอยู่ราว 400–470 นาที ได้ ' + total);
});

test('ทุกหัวข้อของโครงการมีสไลด์ครบ', () => {
  for (const sec of ['open', 't1', 't2', 't3', 't4', 'end']) {
    assert.ok(src.includes(`data-sec="${sec}"`), 'ไม่พบสไลด์ของหมวด ' + sec);
  }
});

test('เป็นไฟล์เดียวที่ไม่พึ่งทรัพยากรภายนอก', () => {
  // ห้ามมี src หรือ href ที่ชี้ออกนอกไฟล์ เพราะห้องอบรมอาจไม่มีอินเทอร์เน็ต
  const ext = [...src.matchAll(/\s(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('#'));
  assert.deepEqual(ext, [], 'พบการอ้างไฟล์ภายนอก: ' + ext.join(', '));
  for (const bad of ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'esm.sh', '@font-face', 'import(']) {
    assert.ok(!src.includes(bad), 'ไม่ควรมี ' + bad + ' ในไฟล์สไลด์');
  }
});

test('มาตรฐานน้ำทิ้งชุมชนอ้างถูกฉบับและครบหกพารามิเตอร์', () => {
  for (const t of ['5.5 – 9.0', 'ไม่เกิน 20 มก./ล.', 'ไม่เกิน 30 มก./ล.', 'ไม่เกิน 5 มก./ล.', 'ไม่เกิน 20 มก.ไนโตรเจน/ล.', 'ไม่เกิน 2 มก.ฟอสฟอรัส/ล.']) {
    assert.ok(src.includes(t), 'ไม่พบค่ามาตรฐาน ' + t);
  }
  assert.ok(src.includes('ไม่มีซีโอดี และไม่มีทีเคเอ็น'), 'ต้องระบุชัดว่ามาตรฐานชุมชนไม่มีซีโอดีและทีเคเอ็น');
  assert.ok(src.includes('127 ตอนพิเศษ 69 ง'), 'ต้องอ้างเล่มราชกิจจานุเบกษาของประกาศมาตรฐานน้ำทิ้ง');
  assert.ok(src.includes('127 ตอนพิเศษ 72 ง'), 'ต้องอ้างเล่มราชกิจจานุเบกษาของประกาศเกณฑ์การออกแบบ');
});

test('แยกค่าของราชการไทยออกจากค่าอ้างอิงสากลและค่าประมาณ', () => {
  for (const b of ['badge gov', 'badge est', 'badge intl', 'badge flag', 'badge calc']) {
    assert.ok(src.includes(b), 'ไม่พบป้าย ' + b);
  }
  assert.ok(src.includes('ไม่มีเอกสารราชการไทยฉบับใดให้ตารางหน่วยไฟต่อลูกบาศก์เมตรของทั้งโรง'),
    'ต้องระบุว่าช่วงหน่วยไฟทั้งโรงไม่ใช่ตัวเลขของราชการไทย');
  assert.ok(src.includes('ไม่ใช่การรับรองสินค้า'), 'ชื่อยี่ห้อต้องติดป้ายว่าไม่ใช่การรับรอง');
  assert.ok(src.includes('ไม่ใช่ราคากลางราชการ'), 'ราคาต้องระบุว่าไม่ใช่ราคากลางราชการ');
});

test('ข้อมูลที่น่าสงสัยถูกแสดง ไม่ถูกกลบ', () => {
  assert.ok(src.includes('40.60, 40.60') || src.includes('[40.60, 40.60]'), 'ต้องคงค่าของแข็งแขวนลอยของจตุจักรตามต้นฉบับ');
  assert.ok(src.includes('capAlt'), 'ต้องเก็บค่าความสามารถบำบัดอีกแหล่งของทุ่งครุไว้');
  assert.ok(src.includes('177000'), 'ต้องแสดงค่าความสามารถบำบัดของทุ่งครุตามทะเบียน กทม. ด้วย');
  assert.ok(/ph: \[2\.50, 2\.59\]/.test(src), 'ต้องคงค่ากรด-ด่างของทุ่งครุตามต้นฉบับเพื่อใช้สอน');
});

test('ค่าสัมประสิทธิ์คาร์บอนอ้างแหล่งที่ตรวจได้', () => {
  assert.ok(src.includes('0.018'), 'ต้องมีค่าสัมประสิทธิ์มีเทน 0.018 กก. ต่อ กก.บีโอดี');
  assert.ok(src.includes('0.016'), 'ต้องมีค่าสัมประสิทธิ์ไนตรัสออกไซด์ 0.016');
  assert.ok(src.includes('0.00016'), 'ต้องแสดงช่วงความไม่แน่นอนของไนตรัสออกไซด์');
  assert.ok(src.includes('ตารางที่ 6.4'), 'ต้องอ้างตารางของ IPCC');
});

test('ค่าการปล่อยของไฟฟ้าใช้ฉบับที่บังคับใช้อยู่ และแยกขอบเขตถูก', () => {
  // ไฟล์ EF CFO (AR5) ของ อบก. ฉบับ ก.พ. 2569 บังคับใช้ตั้งแต่ 1 ม.ค. 2569 · ไฟฟ้า grid mix ปี 2022–2024
  assert.match(src, /efGrid: 0\.4750/, 'ขอบเขตที่ 2 ต้องเป็น 0.4750 ตามฉบับที่บังคับใช้');
  assert.match(src, /efGridS3: 0\.0812/, 'ต้องมีค่าต้นน้ำเชื้อเพลิงของขอบเขตที่ 3 เท่ากับ 0.0812');
  assert.match(src, /efGridCfp: 0\.5562/, 'ต้องมีค่ารวมสำหรับคาร์บอนฟุตพรินต์ของผลิตภัณฑ์เท่ากับ 0.5562');
  assert.ok(src.includes('grid mix ปี 2022–2024') || src.includes('grid mix 2022–2024'), 'ต้องระบุชุดข้อมูลปีของค่าไฟฟ้า');
  assert.ok(src.includes('ฉบับกุมภาพันธ์ 2569') || src.includes('ฉบับ ก.พ. 2569'), 'ต้องระบุฉบับของเอกสาร อบก.');
  assert.ok(src.includes('1 ม.ค. 2569') || src.includes('1 มกราคม 2569'), 'ต้องระบุวันที่เริ่มบังคับใช้');
  assert.ok(src.includes('31 มี.ค. 2569'), 'ต้องเตือนว่าชุดเดิมปี 2016–2018 ใช้ได้ถึง 31 มี.ค. 2569 เท่านั้น');
  assert.ok(src.includes('ตรวจฉบับที่บังคับใช้ก่อนนำไปรายงานทุกครั้ง'), 'บรรณานุกรมต้องเตือนให้ตรวจฉบับก่อนนำไปรายงาน');
  // ค่าเก่าต้องเหลือเฉพาะในบริบทที่อธิบายว่าหมดอายุแล้ว ไม่ใช่ค่าที่ใช้คำนวณ
  assert.ok(!/efGrid:\s*0\.4999/.test(src), 'ต้องไม่ใช้ค่าชุดเดิม 0.4999 ในการคำนวณอีก');
});

test('บล็อกตัวเลขที่ฝังไว้ตรงกับผลจากโมดูลจริง', () => {
  const m = /\/\* DATA:BEGIN \*\/\s*const GEN = ([\s\S]*?);\s*\/\* DATA:END \*\//.exec(src);
  assert.ok(m, 'ไม่พบบล็อก DATA ในไฟล์ · ให้รัน node scripts/build_training_data.mjs');
  const gen = JSON.parse(m[1]);

  const aer = aerationEnergy('AS', { q_m3d: 192644, bod_in: 44.13, bod_out: 4.29, aerator: 'porous' });
  assert.ok(Math.abs(gen.aerKwhDay - aer.kwh_day) < 0.5, 'หน่วยไฟเครื่องเติมอากาศที่ฝังไว้ไม่ตรงกับโมดูล');

  const opt = solarOption({ key: 'roof', name: 'roof', kwh_day: aer.kwh_day, kwp: 500, mount: 'roof', psh: 4.8 });
  assert.ok(Math.abs(gen.prEff - opt.pr_eff) < 1e-3, 'อัตราส่วนสมรรถนะที่ฝังไว้ไม่ตรงกับโมดูล');

  const epc = epcOffer(opt, {});
  const ppa = ppaOffer({ kwh_year0: opt.kwh_year0, load_kwh_year: aer.kwh_day * 365, tariff: 4.2 });
  const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
  assert.ok(Math.abs(num(gen.calc['epc.pb']) - epc.payback_simple) < 0.02, 'ระยะคืนทุนที่ฝังไว้ไม่ตรงกับโมดูล');
  assert.ok(Math.abs(num(gen.calc['epc.npv']) - epc.npv / 1e6) < 0.02, 'มูลค่าปัจจุบันสุทธิที่ฝังไว้ไม่ตรงกับโมดูล');
  assert.ok(Math.abs(num(gen.calc['ppa.tariff1']) - ppa.ppa_tariff_1) < 0.01, 'ค่าไฟตามสัญญาปีแรกที่ฝังไว้ไม่ตรงกับโมดูล');
  assert.equal(gen.epcCum.length, epc.rows.length + 1, 'จำนวนปีของกระแสเงินสดที่ฝังไว้ไม่ตรงกับโมดูล');
});

test('ส่วนลดค่าไฟตามสัญญาเป็นคนละตัวกับอัตราคิดลด', () => {
  assert.ok(src.includes('ส่วนลดค่าไฟตามสัญญา 20% เป็นตัวเลขคนละเรื่องกับอัตราคิดลด 7%'),
    'ต้องเตือนไม่ให้สับสนระหว่างส่วนลด 20% กับอัตราคิดลด 7%');
});

test('ทุกช่องที่รอค่าคำนวณมีค่ารองรับในสคริปต์', () => {
  const used = new Set([...src.matchAll(/data-calc="([^"]+)"/g)].map((m) => m[1]));
  const defined = new Set([...src.matchAll(/["']([a-z0-9]+\.[A-Za-z0-9]+)["']\s*:/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !defined.has(k));
  assert.deepEqual(missing, [], 'ช่องเหล่านี้ยังไม่มีค่ารองรับ: ' + missing.join(', '));
});

test('ไม่มีหมายเลขสไลด์ตายตัวที่จะคลาดเคลื่อนเมื่อเพิ่มสไลด์', () => {
  assert.ok(!src.includes('/ 73</span>'), 'หมายเลขสไลด์ต้องถูกเขียนโดยสคริปต์ ไม่ใช่พิมพ์ตายตัว');
});
