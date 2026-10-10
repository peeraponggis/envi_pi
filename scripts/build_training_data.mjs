/**
 * สร้างบล็อกตัวเลขที่ฝังใน web/training-ai-netzero-2569.html จากโมดูลจริงของระบบ
 *
 * ทำไมต้องมีสคริปต์นี้ — สไลด์อบรมต้องเป็นไฟล์เดียวที่เปิดได้แบบออฟไลน์ จึง import โมดูลตอนแสดงไม่ได้
 * แต่ถ้าพิมพ์ตัวเลขด้วยมือ เลขบนสไลด์จะค้างเมื่อ sensor-catalog.js เปลี่ยน
 * สคริปต์นี้จึงคำนวณด้วย solarSizing/solarOption/epcOffer/ppaOffer/epcVsPpa ตัวจริง
 * แล้วเขียนทับเฉพาะบล็อกระหว่าง DATA:BEGIN และ DATA:END
 *
 * รัน: node scripts/build_training_data.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { solarOption, epcOffer, ppaOffer, epcVsPpa, moduleTempKS, aerationEnergy } from '../web/js/sensor-catalog.js';

const FILE = new URL('../web/training-ai-netzero-2569.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// โรงดินแดง · ฐาน DSPOT กรมควบคุมมลพิษ รายงานปี 2568
const DIN = { q: 192644, bod_in: 44.13, bod_out: 4.29, rai: 17 };
const PSH = 4.8, TARIFF = 4.2, KWP = 500;

// หน่วยไฟเครื่องเติมอากาศจากเกณฑ์ออกแบบไทย (ทวนกับที่สไลด์คำนวณเองได้)
const aer = aerationEnergy('AS', { q_m3d: DIN.q, bod_in: DIN.bod_in, bod_out: DIN.bod_out, aerator: 'porous' });

// ขนาดที่พอดีกับภาระ 500 kWp และข้อเสนอการเงินจากโมดูลจริง
const opt = solarOption({ key: 'roof', name: 'หลังคาหรือโครงคลุมถัง', kwh_day: aer.kwh_day, kwp: KWP, mount: 'roof', psh: PSH });
const epc = epcOffer(opt, {});
const ppa = ppaOffer({ kwh_year0: opt.kwh_year0, load_kwh_year: aer.kwh_day * 365, tariff: TARIFF });
const cmp = epcVsPpa({ epc, ppa, horizon: 15 });

const fmt = (n, d = 0) => n == null || !isFinite(n) ? '–' : Number(n).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });
const cum = (rows, key) => rows.map((r) => r[key] / 1e6);

const GEN = {
  built: new Date().toISOString().slice(0, 10),
  prEff: Number(opt.pr_eff.toFixed(4)),
  tmod: Number(opt.tmod.toFixed(1)),
  aerKwhDay: Number(aer.kwh_day.toFixed(1)),
  epcCum: [-epc.capex / 1e6, ...cum(epc.rows, 'cum')].map((v) => Number(v.toFixed(3))),
  ppaCum: [0, ...cum(ppa.rows, 'cum')].map((v) => Number(v.toFixed(3))),
  calc: {
    'epc.capex': fmt(epc.capex / 1e6, 2),
    'epc.save1': fmt(epc.rows[0].saving / 1e6, 2),
    'epc.pb': fmt(epc.payback_simple, 2),
    'epc.pbd': fmt(epc.payback_discounted, 2),
    'epc.npv': fmt(epc.npv / 1e6, 2),
    'epc.irr': fmt(epc.irr * 100, 1),
    'epc.lcoe': fmt(epc.lcoe, 2),
    'epc.roi': fmt(epc.roi, 1),
    'epc.sum15': fmt(epc.rows.slice(0, 15).reduce((a, r) => a + r.saving, 0) / 1e6, 2) + ' ล้านบาท',
    'ppa.tariff1': fmt(ppa.ppa_tariff_1, 2),
    'ppa.save1': fmt(ppa.first_year_saving / 1e6, 2),
    'ppa.sum15': fmt(ppa.total_saving / 1e6, 2),
    'ppa.npv': fmt(ppa.npv / 1e6, 2),
    'ppa.buyout': String(ppa.buyout_year),
    'cmp.epcNpv': fmt(cmp.epc.npv_h / 1e6, 2) + ' ล้านบาท',
    'sol5.gen': fmt(opt.kwh_year0),
  },
};

const block = `/* DATA:BEGIN */\nconst GEN = ${JSON.stringify(GEN, null, 2).replace(/\n/g, '\n')};\n/* DATA:END */`;
let s = readFileSync(FILE, 'utf8');
const re = /\/\* DATA:BEGIN \*\/[\s\S]*?\/\* DATA:END \*\//;
if (!re.test(s)) throw new Error('ไม่พบบล็อก DATA:BEGIN ถึง DATA:END ในไฟล์สไลด์');
s = s.replace(re, block);
writeFileSync(FILE, s);

console.log('เขียนบล็อกตัวเลขลงไฟล์สไลด์แล้ว');
console.log('  หน่วยไฟเครื่องเติมอากาศ', fmt(aer.kwh_day), 'kWh/วัน ·', fmt(aer.kwh_m3, 4), 'kWh/ลบ.ม. · ตัวควบคุม', aer.governing);
console.log('  โซลาร์', KWP, 'kWp · อัตราส่วนสมรรถนะที่ใช้จริง', GEN.prEff, '· อุณหภูมิแผง', GEN.tmod, '°C · ผลิตปีแรก', fmt(opt.kwh_year0), 'kWh');
console.log('  ลงทุนเอง ลงทุน', GEN.calc['epc.capex'], 'ลบ. · คืนทุน', GEN.calc['epc.pb'], 'ปี · NPV', GEN.calc['epc.npv'], 'ลบ. · IRR', GEN.calc['epc.irr'], '%');
console.log('  มีผู้ลงทุน ค่าไฟปีแรก', GEN.calc['ppa.tariff1'], 'บาท/kWh · ประหยัดรวม 15 ปี', GEN.calc['ppa.sum15'], 'ลบ. · ผู้ชนะที่ 15 ปี', cmp.winner);
