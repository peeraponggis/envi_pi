// เทสต์ส่วนโซลาร์เชิงพาณิชย์และการเงิน · ยึดค่าที่รู้คำตอบล่วงหน้าเป็นหลัก
// ทุกตัวเลขอ้างอิงในโมดูลเป็นค่าประมาณ เทสต์จึงตรวจ "วิธีคิด" และความสอดคล้อง ไม่ใช่ความถูกต้องของราคาตลาด
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  npv, irr, paybackYears, lcoe, simpleRoi, capexTier, capexPerKwp, batteryBankSizing, solarOption,
  cashflow, billEnergy, plantEnergyResolved, ppaOffer, epcOffer, epcVsPpa,
  CAPEX_TIERS, MOUNTS, FIN_DEFAULTS, PPA_DEFAULTS, STEP, PROCESS_TYPES,
} from '../web/js/sensor-catalog.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ต่างจาก ${b} เกิน ${tol}`);

test('มูลค่าปัจจุบันสุทธิและอัตราผลตอบแทนภายใน ตรงกับค่าที่รู้คำตอบ', () => {
  near(npv(0.1, [-1000, 500, 500, 500]), 243.4259955, 1e-6);
  assert.equal(npv(0, [-100, 50, 50]), 0);
  near(irr([-1000, 500, 500, 500]), 0.23375, 1e-4);
  near(irr([-100, 60, 60]), 0.130662, 1e-5);
  // ตรวจย้อน: ที่อัตราผลตอบแทนภายใน มูลค่าปัจจุบันสุทธิต้องเป็นศูนย์
  const f = [-2500, 700, 700, 700, 700, 700];
  assert.ok(Math.abs(npv(irr(f), f)) < 1e-5);
  // กระแสเงินสดที่ไม่เปลี่ยนเครื่องหมาย ต้องคืน null ไม่ใช่ NaN
  assert.equal(irr([-100, -10, -10]), null);
  assert.equal(irr([100, 50]), null);
  assert.equal(irr([]), null);
});

test('ระยะคืนทุนและต้นทุนไฟฟ้าต่อหน่วย', () => {
  assert.equal(paybackYears([-1000, 400, 400, 400, 400]), 2.5);
  assert.equal(paybackYears([-1000, 100, 100]), null, 'ไม่คืนทุนต้องคืน null');
  const f = [-1000, 400, 400, 400, 400];
  assert.ok(paybackYears(f, { rate: 0.07 }) > paybackYears(f), 'คืนทุนแบบคิดลดต้องยาวกว่าแบบง่าย');
  // เงินลงทุน 100,000 ผลิตปีละ 10,000 kWh สิบปี ไม่มีค่าดูแล อัตราคิดลดศูนย์ → 1.0 บาท/kWh พอดี
  near(lcoe({ capex: 100000, om_by_year: Array(10).fill(0), kwh_by_year: Array(10).fill(10000), discount: 0 }), 1);
  const a = lcoe({ capex: 100000, om_by_year: Array(10).fill(0), kwh_by_year: Array(10).fill(10000), discount: 0 });
  const b = lcoe({ capex: 100000, om_by_year: Array(10).fill(0), kwh_by_year: Array(10).fill(10000), discount: 0.07 });
  assert.ok(b > a, 'อัตราคิดลดสูงขึ้นทำให้ต้นทุนต่อหน่วยสูงขึ้น เพราะผลผลิตถูกคิดลดแต่เงินลงทุนอยู่ที่เวลาศูนย์');
  near(simpleRoi({ total_net: 250, capex: 1000 }), 0.25);
  assert.equal(simpleRoi({ total_net: 250, capex: 0 }), null);
});

test('ชั้นราคาตามขนาดและตัวคูณวิธีติดตั้ง', () => {
  assert.deepEqual([capexTier(50).lo, capexTier(50).hi], [25000, 30000]);
  assert.deepEqual([capexTier(500).lo, capexTier(500).hi], [20000, 25000]);
  assert.deepEqual([capexTier(2000).lo, capexTier(2000).hi], [18000, 22000]);
  assert.deepEqual([capexTier(4000).lo, capexTier(4000).hi], [16000, 20000]);
  assert.deepEqual([capexTier(8000).lo, capexTier(8000).hi], [14000, 18000]);
  // ขอบเขตชั้นราคาเป็นแบบรวมค่าที่ระบุ
  assert.equal(capexTier(100).index, 0); assert.equal(capexTier(100.1).index, 1);
  assert.equal(capexTier(1000).index, 1); assert.equal(capexTier(1000.1).index, 2);
  const roof = capexPerKwp({ kwp: 500, mount: 'roof' });
  const ground = capexPerKwp({ kwp: 500, mount: 'ground' });
  const float = capexPerKwp({ kwp: 500, mount: 'floating' });
  near(ground.per_kwp.mid, roof.per_kwp.mid * 1.10, 1e-9);
  near(float.per_kwp.mid, roof.per_kwp.mid * 1.275, 1e-9);
  assert.ok(float.per_kwp.mid > ground.per_kwp.mid && ground.per_kwp.mid > roof.per_kwp.mid, 'ทุ่นลอยน้ำแพงกว่าพื้นดินแพงกว่าหลังคาเสมอ');
  near(float.yield_mult.mid, 1.075, 1e-9);
  // ราคาที่ผู้ใช้กรอกเองต้องข้ามตารางชั้นราคา
  near(capexPerKwp({ kwp: 500, mount: 'roof', override: 30000 }).per_kwp.mid, 30000, 1e-9);
  // ที่มาของตัวคูณทุ่นลอยน้ำต้องบอกชัดว่าไม่ใช่ตัวเลขของไทย
  assert.ok(/ไม่ใช่.*ไทย/.test(MOUNTS.floating.source), 'ต้องระบุว่าตัวคูณทุ่นลอยน้ำเป็นค่าอ้างอิงสากล');
});

test('ทางเลือกโซลาร์: ทุ่นลอยน้ำได้ผลผลิตมากกว่า ไฮบริดแพงกว่าออนกริด', () => {
  const base = solarOption({ kwh_day: 1000, psh: 4.8, mount: 'roof' });
  const size = base.kwp;
  const roof = solarOption({ kwh_day: 1000, kwp: size, psh: 4.8, mount: 'roof' });
  const float = solarOption({ kwh_day: 1000, kwp: size, psh: 4.8, mount: 'floating' });
  const ground = solarOption({ kwh_day: 1000, kwp: size, psh: 4.8, mount: 'ground' });
  assert.ok(float.kwh_year0 > roof.kwh_year0, 'ทุ่นลอยน้ำแผงเย็นกว่าจึงได้ผลผลิตมากกว่าที่ขนาดเท่ากัน');
  assert.ok(float.capex.total.mid > ground.capex.total.mid && ground.capex.total.mid > roof.capex.total.mid);
  const hybrid = solarOption({ kwh_day: 1000, kwp: size, psh: 4.8, mount: 'roof', hybrid: true });
  assert.ok(hybrid.capex.total.mid > roof.capex.total.mid, 'ไฮบริดต้องแพงกว่าออนกริดที่วิธีติดตั้งเดียวกัน');
  assert.ok(hybrid.battery.kwh_nominal > 0 && hybrid.battery.life_years > 0);
  near(hybrid.battery.kwh_nominal, 1000 * 0.35 / (0.9 * 0.9), 1e-9);
  assert.equal(solarOption({ kwh_day: 0 }), null);
});

test('กระแสเงินสด: แผงเสื่อม ค่าไฟขึ้น และเปลี่ยนอินเวอร์เตอร์ตรงปี', () => {
  const cf = cashflow({ capex: 1000000, kwp: 100, kwh_year0: 150000, tariff: 4.2, years: 25 });
  assert.equal(cf.rows.length, 25);
  near(cf.rows[0].kwh, 150000, 1e-6);
  near(cf.rows[1].kwh, 150000 * 0.98, 1e-6);
  near(cf.rows[2].kwh, 150000 * 0.98 * 0.996, 1e-6);
  near(cf.rows[1].tariff_y, 4.2 * 1.03, 1e-9);
  near(cf.rows[0].om, 1000000 * FIN_DEFAULTS.om_rate, 1e-9);
  assert.equal(cf.rows[10].capexOut, FIN_DEFAULTS.inverter_per_kwp * 100, 'เปลี่ยนอินเวอร์เตอร์ปีที่ 11');
  assert.equal(cf.rows[9].capexOut, 0); assert.equal(cf.rows[11].capexOut, 0);
  near(cf.rows.at(-1).cum, cf.total_net - cf.capex, 1e-6);
  // สองเส้นทางคำนวณต้องได้ผลเดียวกัน
  near(cf.npv, npv(cf.discount, cf.flows), 1e-6);
  // ผลิตเกินโหลด ส่วนเกินไม่มีมูลค่าเมื่อไม่มีค่าไฟส่วนเกิน
  const capped = cashflow({ capex: 1000000, kwp: 100, kwh_year0: 150000, tariff: 4.2, load_kwh_year: 80000 });
  assert.equal(capped.rows[0].kwh_used, 80000);
  assert.ok(capped.rows[0].kwh_export > 0);
  assert.ok(capped.rows[0].saving < cf.rows[0].saving, 'โหลดน้อยกว่าผลผลิต ทำให้ประหยัดได้น้อยลง');
});

test('บิลค่าไฟใช้แทนค่าประมาณ และคิดหน่วยไฟต่อลูกบาศก์เมตรย้อนกลับได้', () => {
  const b = billEnergy({ kwh_month: 10000, baht_month: 42000 });
  assert.equal(b.tariff, 4.2);
  assert.equal(b.estimate, false);
  near(b.kwh_day, 10000 * 12 / 365, 1e-9);
  assert.equal(billEnergy({ kwh_month: 0, baht_month: 100 }), null);
  assert.equal(billEnergy({}), null);
  // ลำดับความสำคัญ บิล มาก่อน น้ำเข้าจริง มาก่อน ความสามารถออกแบบ
  assert.equal(plantEnergyResolved('AS', { capacity: 5000 }).basis, 'design');
  assert.equal(plantEnergyResolved('AS', { capacity: 5000, avg_inflow: 3000 }).basis, 'actual');
  const r = plantEnergyResolved('AS', { capacity: 5000, avg_inflow: 3000, bill: b });
  assert.equal(r.basis, 'bill');
  assert.equal(r.estimate, false);
  assert.ok(/ใบแจ้งหนี้/.test(r.source));
  near(r.kwh_m3_implied, b.kwh_day / 3000, 1e-9);
  assert.equal(typeof r.in_band, 'boolean');
  // บิลที่กินไฟสูงผิดปกติต้องออกนอกช่วงอ้างอิง
  const heavy = plantEnergyResolved('SP', { capacity: 1000, bill: billEnergy({ kwh_month: 90000, baht_month: 400000 }) });
  assert.equal(heavy.in_band, false, 'บ่อปรับเสถียรกินไฟ 3 kWh/m³ ถือว่าผิดปกติ');
});

test('ข้อเสนอมีผู้ลงทุน: ส่วนลดค่าไฟ 20% คิดจากอัตราค่าไฟ ไม่ใช่อัตราคิดลด', () => {
  const p = ppaOffer({ kwh_year0: 100000, tariff: 5, term_years: 15, discount_pct: 0.20 });
  assert.equal(p.ppa_tariff_1, 4, 'ค่าไฟตามสัญญาปีแรกเท่ากับ 80% ของค่าไฟการไฟฟ้า');
  assert.equal(p.capex, 0);
  assert.equal(p.irr, null, 'ไม่มีเงินลงทุนของเจ้าของโครงการ จึงไม่มีอัตราผลตอบแทนภายใน');
  assert.equal(p.rows.length, 15);
  // อัตราขึ้นเท่ากันทั้งสองฝั่ง ส่วนลดคงที่ตลอดสัญญา
  const eq = ppaOffer({ kwh_year0: 100000, tariff: 5, discount_pct: 0.2, ppa_escalator: 0.03, grid_escalation: 0.03, degradation_first: 0, degradation: 0 });
  near(eq.rows[0].saving, 100000 * 5 * 0.2, 1e-6);
  assert.equal(eq.crossover_year, null, 'อัตราขึ้นเท่ากัน ค่าไฟตามสัญญาไม่มีวันแซงค่าไฟการไฟฟ้า');
  // ค่าไฟตามสัญญาขึ้นเร็วกว่ากริด สุดท้ายต้องแซงและกลายเป็นขาดทุน
  const bad = ppaOffer({ kwh_year0: 100000, tariff: 5, discount_pct: 0.05, ppa_escalator: 0.09, grid_escalation: 0.01, term_years: 20 });
  assert.ok(bad.crossover_year != null && bad.rows.at(-1).saving < 0, 'ต้องเตือนได้เมื่อค่าไฟตามสัญญาแซงค่าไฟการไฟฟ้า');
});

test('เทียบลงทุนเองกับมีผู้ลงทุนที่กรอบเวลาเดียวกัน', () => {
  const o = solarOption({ kwh_day: 1000, psh: 4.8, mount: 'roof' });
  const e = epcOffer(o, { tariff: 4.2 });
  const p = ppaOffer({ kwh_year0: o.kwh_year0, tariff: 4.2 });
  const c = epcVsPpa({ epc: e, ppa: p, horizon: 15 });
  assert.equal(c.horizon, 15);
  assert.ok(['epc', 'ppa', 'tie'].includes(c.winner));
  near(c.delta_npv, c.epc.npv_h - c.ppa.npv_h, 1e-6);
  assert.ok(/โอนทรัพย์สิน/.test(c.residual_note), 'ต้องบอกเรื่องกรรมสิทธิ์ที่เหลืออยู่');
  // สองข้อเสนอที่ผลใกล้กันมากต้องตัดสินว่าเสมอ
  const tie = epcVsPpa({ epc: { ...e, rows: e.rows, capex: e.capex }, ppa: { ...p, npv: c.epc.npv_h * 1.001 }, horizon: 15 });
  assert.equal(tie.winner, 'tie');
});

test('กติกาของผลลัพธ์: มี steps ทุกตัว และ formula ห้ามมีวงเล็บแหลม', () => {
  const o = solarOption({ kwh_day: 800, psh: 4.8, mount: 'floating', hybrid: true });
  const results = [
    billEnergy({ kwh_month: 5000, baht_month: 21000 }),
    plantEnergyResolved('OD', { capacity: 5000, avg_inflow: 3000 }),
    capexPerKwp({ kwp: 300, mount: 'ground' }),
    batteryBankSizing({ kwh_cycle: 200 }),
    o, epcOffer(o, {}), ppaOffer({ kwh_year0: o.kwh_year0, tariff: 4.2 }),
    epcVsPpa({ epc: epcOffer(o, {}), ppa: ppaOffer({ kwh_year0: o.kwh_year0, tariff: 4.2 }) }),
  ];
  for (const r of results) {
    assert.ok(Array.isArray(r.steps) && r.steps.length > 0, 'ทุกผลลัพธ์ต้องมีวิธีคิด');
    for (const s of r.steps) {
      assert.ok(typeof s.label === 'string' && s.label.length > 0, 'ทุกขั้นต้องมีชื่อเป็นภาษาไทย');
      assert.ok(typeof s.formula === 'string' && /\d/.test(s.formula), 'สูตรต้องมีตัวเลขที่แทนค่าแล้ว: ' + s.label);
      assert.ok(s.value === null || typeof s.value === 'number', 'ค่าผลลัพธ์ต้องเป็นตัวเลขหรือ null: ' + s.label);
      assert.ok(typeof s.unit === 'string', 'ต้องมีหน่วย: ' + s.label);
      // ตารางฝั่งหน้าเว็บถอดแท็กด้วย /<[^>]+>/g สูตรที่มีวงเล็บแหลมจะทำให้ข้อความหายทั้งท่อน
      assert.ok(!/[<>]/.test(s.formula), 'สูตรห้ามมีอักขระ < หรือ >: ' + s.formula);
      assert.ok(!/[<>]/.test(s.label), 'ชื่อขั้นห้ามมีอักขระ < หรือ >: ' + s.label);
    }
    if (r.estimate === true) assert.ok(typeof r.source === 'string' && r.source.length > 0, 'ค่าประมาณต้องบอกที่มา');
  }
  assert.deepEqual(STEP('ก', 'ข = 1', 1, 'หน่วย'), { label: 'ก', formula: 'ข = 1', value: 1, unit: 'หน่วย', ref: null });
});

test('แคตตาล็อกยังบริสุทธิ์ ไม่แตะ DOM หรือเครือข่าย', () => {
  const src = readFileSync(new URL('../web/js/sensor-catalog.js', import.meta.url), 'utf8');
  for (const bad of ['document.', 'window.', 'localStorage', 'fetch(', 'XMLHttpRequest']) {
    assert.ok(!src.includes(bad), `sensor-catalog.js ต้องไม่อ้าง ${bad}`);
  }
});

test('ค่าอ้างอิงทุกก้อนบอกที่มา และช่วงราคาเรียงจากต่ำไปสูง', () => {
  for (const t of CAPEX_TIERS) assert.ok(t.lo <= t.hi, 'ช่วงราคาต้องเรียงถูก');
  for (const m of Object.values(MOUNTS)) {
    assert.ok(m.cost[0] <= m.cost[1] && m.cost[1] <= m.cost[2], m.name + ' ตัวคูณราคาต้องเรียง');
    assert.ok(m.yield[0] <= m.yield[1] && m.yield[1] <= m.yield[2], m.name + ' ตัวคูณผลผลิตต้องเรียง');
    assert.ok(typeof m.source === 'string' && m.source.length > 10, m.name + ' ต้องบอกที่มา');
  }
  assert.equal(PPA_DEFAULTS.term_years, 15);
  assert.equal(PPA_DEFAULTS.discount_pct, 0.20);
  assert.equal(FIN_DEFAULTS.discount, 0.07, 'อัตราคิดลดทางการเงินแยกจากส่วนลดค่าไฟของสัญญา');
  // benchmark พลังงานของทุกประเภทระบบต้องระบุว่าไม่ใช่ตัวเลขราชการไทย
  for (const p of Object.values(PROCESS_TYPES)) assert.ok(/ไม่ใช่ตัวเลข/.test(p.energy.source), p.code + ' ต้องระบุที่มาของ benchmark พลังงาน');
});

test('plantEnergyResolved คืนหน่วยไฟต่อวันจริง ไม่ใช่ศูนย์ (เคยพลาดเพราะ plantEnergy ใช้คีย์ mid)', () => {
  const d = plantEnergyResolved('OD', { capacity: 24000 });
  assert.ok(d.kwh_day > 0, 'ต้องคิดหน่วยไฟจากความสามารถออกแบบได้');
  near(d.kwh_day, 24000 * PROCESS_TYPES.OD.energy.kwh_m3.reduce((a, b) => a + b, 0) / 2, 1e-6);
  const a = plantEnergyResolved('AS', { capacity: 10000, avg_inflow: 4000 });
  near(a.kwh_day, 4000 * 0.45, 1e-6);
  near(a.kwh_m3_implied, 0.45, 1e-9);
  assert.equal(a.in_band, true);
});

test('พลังงานเติมอากาศคิดจากเกณฑ์ออกแบบไทย ไม่ใช่ตัวเลขวรรณกรรมต่างประเทศ', async () => {
  const { aerationEnergy, AERATOR_SAE, THAI_SEWAGE, PCD_AERATION } = await import('../web/js/sensor-catalog.js');
  const r = aerationEnergy('AS', { q_m3d: 10000 });
  // บีโอดีน้ำเข้าใช้ค่าแนะนำของท่อระบายรวมตามตารางที่ 2.2
  assert.equal(r.bod_in, 80);
  near(r.removed_kg, 10000 * (80 - 20) / 1000, 1e-9);
  near(r.o2_kg, r.removed_kg * 1.5, 1e-9);
  assert.ok(r.kwh_day > 0 && r.kwh_m3 > 0);
  assert.equal(r.governing, 'oxygen', 'ระบบเติมอากาศยืดเวลาไม่มีเกณฑ์กำลังกวน จึงคุมด้วยความต้องการออกซิเจน');
  // สระเติมอากาศมีเกณฑ์กำลังกวน 1.5–3.0 กิโลวัตต์ต่อ 1,000 ลบ.ม. ซึ่งมักเป็นตัวควบคุม
  const al = aerationEnergy('AL', { q_m3d: 10000 });
  assert.equal(al.governing, 'mixing');
  near(al.kwh_mix, 10000 * 1 * 24 / 24 / 1000 * 2.25 * 24, 1e-6);
  // น้ำเสียเข้มข้นขึ้น ใช้ไฟมากขึ้นเสมอ
  assert.ok(aerationEnergy('AS', { q_m3d: 10000, bod_in: 160 }).kwh_day > r.kwh_day);
  // ปริมาณน้ำเป็นสัดส่วนตรง หน่วยไฟต่อลูกบาศก์เมตรจึงคงที่
  near(aerationEnergy('AS', { q_m3d: 20000 }).kwh_m3, r.kwh_m3, 1e-9);
  assert.equal(aerationEnergy('AS', { q_m3d: 0 }), null);
  assert.equal(aerationEnergy('CW', { q_m3d: 1000 }), null, 'บึงประดิษฐ์ไม่มีเครื่องเติมอากาศ');
  // ต้องบอกชัดว่าเป็นเฉพาะไฟเครื่องเติมอากาศ และตัวปรับในสนามเป็นข้อสมมติของเราเอง
  assert.ok(/เฉพาะไฟของเครื่องเติมอากาศ/.test(r.source) && /ข้อสมมติของเรา/.test(r.source));
  assert.ok(r.steps.length >= 6 && r.steps.every((x) => !/[<>]/.test(x.formula)));
  // ค่าประสิทธิภาพเครื่องเติมอากาศตรงตามตารางที่ 7.5
  assert.deepEqual(AERATOR_SAE.porous.sae, [1.9, 6.6]);
  assert.deepEqual(AERATOR_SAE.horizontal.sae, [1.5, 2.1]);
  assert.deepEqual(THAI_SEWAGE.combined.bod_range, [65, 110]);
  assert.deepEqual(PCD_AERATION.AL.o2_per_bod, [0.7, 1.0]);
  assert.deepEqual(PCD_AERATION.AS.o2_per_bod, [1.4, 1.6]);
});

test('ตัวเลขเกณฑ์ออกแบบอ้างประกาศราชกิจจานุเบกษา ไม่ใช่แค่คู่มือ', async () => {
  const { PROCESS_TYPES, THAI_SEWAGE, AERATOR_SAE, aerationEnergy } = await import('../web/js/sensor-catalog.js');
  const cite = /ราชกิจจานุเบกษา/;
  assert.ok(cite.test(THAI_SEWAGE.source), 'ลักษณะน้ำเสียไทยต้องอ้างประกาศ');
  assert.ok(cite.test(aerationEnergy('AS', { q_m3d: 1000 }).source), 'พลังงานเติมอากาศต้องอ้างประกาศ');
  for (const c of ['AS', 'OD', 'SBR', 'AL', 'SP']) {
    assert.ok(/ประกาศกรมควบคุมมลพิษ/.test(PROCESS_TYPES[c].design_note), c + ' เกณฑ์ออกแบบต้องอ้างประกาศกรมควบคุมมลพิษ');
  }
  // เครื่องเติมอากาศครบทุกชนิดในตารางที่ 7.5 ของประกาศ
  assert.deepEqual(AERATOR_SAE.aspirating.sae, [0.5, 0.8]);
  assert.deepEqual(AERATOR_SAE.turbine.sae, [1.1, 2.1]);
  assert.equal(Object.keys(AERATOR_SAE).length, 8);
});
