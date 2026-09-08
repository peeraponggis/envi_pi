import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCESS_TYPES, PROCESS_CODES, SENSOR_TYPES, BRAND_EXAMPLES, ALL_PARAM_INFO, STAGES, sensorFor, designSystem, powerBudget, plantEnergy,
  measuredIntensity, solarSizing, batterySizing, pshFromDede, makeSeries, summarizeSeries, payloadFor, designToURL, designFromURL, levelFor, allStagesOf,
} from '../web/js/sensor-catalog.js';

test('ทุกชนิดระบบมี stage/monitor ครบ และพารามิเตอร์ทุกตัวมีคำอธิบาย + เซนเซอร์รองรับ', () => {
  for (const code of PROCESS_CODES) {
    const p = PROCESS_TYPES[code];
    assert.ok(p.stages.length >= 4, code + ' stages');
    for (const s of p.stages) assert.ok(STAGES[s], `${code}: ไม่รู้จัก stage ${s}`);
    assert.ok(p.monitor.some((m) => m.required), code + ' ต้องมีจุดวัดบังคับ');
    for (const m of p.monitor) {
      assert.ok(ALL_PARAM_INFO[m.param], `${code}: ไม่มีคำอธิบาย ${m.param}`);
      assert.ok(allStagesOf(code).includes(m.stage), `${code}: stage ${m.stage} ไม่อยู่ในกระบวนการ`);
      assert.ok(m.sensor ?? sensorFor(m.param, m.stage), `${code}: ไม่มีเซนเซอร์สำหรับ ${m.param}`);
    }
    // ลำดับการไหลของน้ำต้องเริ่มที่น้ำเข้า ผ่านหน่วยเตรียมน้ำ และจบที่น้ำทิ้งออก
    assert.equal(p.stages[0], 'inlet', code + ' ต้องเริ่มที่น้ำเข้า');
    assert.ok(p.stages.includes('screen'), code + ' ต้องมีตะแกรงดักขยะ');
    assert.ok(p.desc && p.design_note, code + ' ต้องมีคำอธิบายกระบวนการและเกณฑ์ออกแบบ');
    for (const r of p.recycles ?? []) {
      assert.ok(STAGES[r.id]?.kind === 'return', `${code}: สายวนกลับ ${r.id} ต้องนิยามใน STAGES เป็น return`);
      assert.ok(p.stages.includes(r.from) || r.from === 'plant', `${code}: สายวนกลับออกจาก ${r.from} ที่ไม่มีในกระบวนการ`);
      assert.ok(p.stages.includes(r.to) || r.to === 'plant' || (p.sludge ?? []).includes(r.to), `${code}: สายวนกลับเข้า ${r.to} ที่ไม่มีในกระบวนการ`);
    }
    // จัดการตะกอนและก๊าซเป็นสายแยก ไม่ใช่ปลายทางของสายน้ำ
    for (const u of p.sludge ?? []) assert.ok(STAGES[u]?.kind === 'sludge', `${code}: หน่วยจัดการตะกอน ${u} ต้องนิยามใน STAGES เป็น sludge`);
    assert.equal(p.stages[p.stages.length - 1], 'outlet', code + ': ลำดับการไหลต้องจบที่น้ำทิ้งออก');
    assert.ok(p.energy.kwh_m3[0] <= p.energy.kwh_m3[1] && p.energy.estimate === true && p.energy.source, code + ' energy');
    for (const [k] of Object.entries(p.sim)) assert.ok(ALL_PARAM_INFO[k], `${code}: sim ${k} ไม่มีคำอธิบาย`);
  }
});

test('เซนเซอร์ทุกชนิดมีมาตรฐาน ราคา พลังงาน และแบรนด์ตัวอย่างอ้างถึงชนิดที่มีอยู่จริง', () => {
  for (const [k, t] of Object.entries(SENSOR_TYPES)) {
    assert.ok(t.stds.length && t.power_w[0] <= t.power_w[1] && t.price_thb[0] <= t.price_thb[1] && t.estimate === true, k);
  }
  for (const b of BRAND_EXAMPLES) assert.ok(SENSOR_TYPES[b.sensor] && b.brand && b.model && Array.isArray(b.certs), b.model);
});

test('designSystem AS 5,000 m³/d มี DO ที่ถังเติมอากาศ, BOD/COD/TSS ที่น้ำออก และอุปกรณ์กลางครบ', () => {
  const d = designSystem('AS', 5000);
  const at = (stage, param) => d.items.find((i) => i.stage === stage && i.param === param);
  assert.ok(at('aeration', 'DO')?.required && at('aeration', 'DO').sensor === 'DO');
  assert.ok(at('outlet', 'eff:BOD')?.required && at('outlet', 'eff:BOD').sensor === 'BOD');
  assert.equal(at('outlet', 'eff:COD').sensor, 'COD');
  assert.equal(at('inlet', 'Flow').sensor, 'Flow_us');
  for (const s of ['Controller', 'Logger', 'Gateway']) assert.ok(d.items.some((i) => i.sensor === s), s);
  assert.equal(designSystem('AS', 150000).items.find((i) => i.param === 'DO' && i.stage === 'aeration').qty, 4, 'โรงใหญ่เพิ่มหัว DO');
  assert.ok(designSystem('IND', 1000).diw_rule, 'โรงงานต้องมีข้อกำหนด POMS');
  assert.ok(designSystem('AS', 5000, { requiredOnly: true }).items.every((i) => i.required));
});

test('powerBudget รวมกำลังไฟตาม qty และ duty', () => {
  const d = designSystem('SP', 2000);
  const b = powerBudget(d);
  assert.ok(b.w_avg > 0 && b.w_peak >= b.w_avg && b.kwh_day === b.w_avg * 24 / 1000 && b.price_lo <= b.price_hi && b.estimate);
  const half = powerBudget(d, { dutyDefault: 0.5 });
  assert.ok(Math.abs(half.w_avg - b.w_avg / 2) < 1e-9);
});

test('plantEnergy lo≤mid≤hi ทั้งตามออกแบบและน้ำเข้าจริง · measuredIntensity guard หาร 0', () => {
  const e = plantEnergy('AS', { capacity: 10000, avg_inflow: 4000 });
  assert.ok(e.design.lo <= e.design.mid && e.design.mid <= e.design.hi && e.design.mid === 0.45 * 10000);
  assert.equal(e.actual.q, 4000); assert.equal(e.estimate, true);
  assert.equal(plantEnergy('SP', { capacity: 1000 }).actual, null);
  assert.equal(measuredIntensity(50, 0), null);
  assert.ok(Math.abs(measuredIntensity(50, 100).kwh_m3 - 0.5) < 1e-9);
});

test('solarSizing: 100 kWh/วัน PSH 5 PR 0.78 → ราว 25.6 kWp (margin 1.0)', () => {
  const s = solarSizing({ kwh_day: 100, psh: 5, airTemp: 25, windSpeed: 1.5, pr0: 0.8, tempCoef: 0, sizing_margin: 1 });
  assert.ok(Math.abs(s.kwp - 25) < 1e-9, 'kWp = 100/(5×0.8)');
  const hot = solarSizing({ kwh_day: 100, psh: 5, airTemp: 35, windSpeed: 0.5 });
  assert.ok(hot.pr < 0.8 && hot.tmod > 35 && hot.kwp > 25, 'อากาศร้อน PR ลด kWp เพิ่ม');
  assert.ok(hot.area_m2 > 0 && hot.cost_thb > 0 && hot.payback_years > 0 && hot.estimate);
  assert.equal(solarSizing({ kwh_day: 0 }), null);
  assert.ok(Math.abs(batterySizing({ w_avg: 100 }).wh - 100 * 12 * 2 / 0.8) < 1e-9);
  assert.ok(Math.abs(pshFromDede({ annual_kwh_m2: 1825 }) - 5) < 1e-9);
  assert.ok(Math.abs(pshFromDede({ monthly: Array(12).fill(18) }) - 5) < 1e-9);
});

test('makeSeries: seed เดิมผลเท่ากัน ค่าไม่ติดลบ pH ในช่วง และ event ทำให้ค่าพุ่ง', () => {
  const a = makeSeries('AS', 'DO', { hours: 48, seed: 7 }), b = makeSeries('AS', 'DO', { hours: 48, seed: 7 });
  assert.deepEqual(a, b); assert.equal(a.length, 48); assert.ok(a.every((p) => p.v >= 0));
  assert.notDeepEqual(a, makeSeries('AS', 'DO', { hours: 48, seed: 8 }));
  assert.ok(makeSeries('SP', 'PH', { hours: 200, seed: 1 }).every((p) => p.v >= 5 && p.v <= 9.5));
  const flow = makeSeries('AS', 'Flow', { hours: 24, seed: 1, capacity: 24000 });
  assert.ok(Math.abs(flow.reduce((s, p) => s + p.v, 0) / 24 - 1000) < 200, 'Flow เฉลี่ย ≈ capacity/24');
  const ev = makeSeries('IND', 'eff:COD', { hours: 48, seed: 3, event: { type: 'spike', at: 10, hours: 4, factor: 5 } });
  const base = makeSeries('IND', 'eff:COD', { hours: 48, seed: 3 });
  assert.ok(ev[11].v > base[11].v * 3);
  const sum = summarizeSeries('eff:COD', ev);
  assert.equal(sum.key, 'eff:COD'); assert.ok(sum.exceed.length >= 1 && sum.n === 48);
  assert.equal(makeSeries('AS', 'ไม่มี', {}).length, 0);
});

test('levelFor รองรับพารามิเตอร์เพิ่มเติม (MLSS) และของราชการ (eff:COD)', () => {
  assert.equal(levelFor('MLSS', 3000), 'good'); assert.equal(levelFor('MLSS', 1000), 'bad'); assert.equal(levelFor('eff:COD', 500), 'bad'); assert.equal(levelFor('ORP', 50), 'none');
});

test('payloadFor และ designToURL/FromURL', () => {
  const d = designSystem('AS', 5000);
  const p = payloadFor(d, d.items.find((i) => i.param === 'eff:COD'), 88, '2026-09-06T10:00:00+07:00', 'CM01');
  assert.equal(p.mqtt.topic, 'envi/CM01/outlet/COD'); assert.equal(p.cloud.row.parameter, 'CM01:COD'); assert.equal(p.cloud.row.value, 88); assert.equal(p.dashboard.level, 'good');
  const qs = designToURL({ type: 'AS', cap: 5000, lat: 18.7, lng: 98.9, seed: 42, qty: { 'aeration:DO': 2 } });
  const back = designFromURL(qs);
  assert.equal(back.type, 'AS'); assert.equal(back.cap, 5000); assert.equal(back.lat, 18.7); assert.equal(back.qty['aeration:DO'], 2);
});

test('ผังกระบวนการตรงตามคู่มือระบบบำบัดน้ำเสียชุมชน กรมควบคุมมลพิษ 2563', () => {
  const st = (c) => PROCESS_TYPES[c].stages;
  const rec = (c) => (PROCESS_TYPES[c].recycles ?? []).map((r) => r.id);
  // ทุกระบบมีบ่อสูบน้ำเสียและตะแกรงดักขยะเป็นหน่วยรับน้ำ ตามคู่มือ คพ. หมวดการบำบัดทางกายภาพ
  for (const c of PROCESS_CODES) {
    assert.ok(st(c).includes('pump'), c + ' ต้องมีบ่อสูบน้ำเสีย');
    assert.ok(st(c).includes('screen'), c + ' ต้องมีตะแกรงดักขยะ');
  }
  // บ่อปรับเสถียร: ชุดบ่ออนุกรม และคู่มือระบุว่าไม่จำเป็นต้องมีระบบฆ่าเชื้อโรค
  assert.deepEqual(st('SP').filter((x) => x.startsWith('pond')), ['pondA', 'pondF', 'pondAe', 'pondM'], 'SP ต้องเป็นชุดบ่อ 4 แบบตามคู่มือ');
  assert.ok(!st('SP').includes('chlorine') && !st('SP').includes('contact'), 'SP ต้องไม่มีบ่อเติมคลอรีน');
  // สระเติมอากาศ: บ่อเติมอากาศ บ่อบ่ม บ่อเติมคลอรีน และไม่มีการสูบสลัดจ์กลับ
  assert.deepEqual(st('AL').slice(-4), ['lagoon', 'pondM', 'chlorine', 'outlet'], 'AL ต้องจบด้วยบ่อเติมอากาศ บ่อบ่ม บ่อเติมคลอรีน');
  assert.ok(!rec('AL').includes('ras'), 'AL เป็นระบบไหลผ่าน ไม่มีการสูบสลัดจ์กลับ');
  // ตะกอนเร่งทุกแบบที่แยกสลัดจ์ในถังต่างหาก ต้องมีสายสูบสลัดจ์กลับ
  for (const c of ['AS', 'OD', 'MBR', 'IND']) assert.ok(rec(c).includes('ras'), c + ' ต้องมีสายสูบสลัดจ์กลับ');
  // โรงชุมชนไทยแบบกวนสมบูรณ์ไม่มีถังตกตะกอนขั้นต้น
  assert.ok(!st('AS').includes('primary'), 'AS ชุมชนไทยต้องไม่มีถังตกตะกอนขั้นต้น');
  assert.ok(st('AS').includes('contact'), 'AS ต้องมีถังสัมผัสคลอรีน');
  // คลองวนเวียนและแผ่นหมุนชีวภาพมีบ่อปรับสภาพการไหลเป็นหน่วยมาตรฐาน
  for (const c of ['OD', 'RBC']) assert.ok(st(c).includes('eq'), c + ' ต้องมีบ่อปรับสภาพการไหล');
  assert.ok(st('OD').includes('gritCh'), 'OD ใช้รางดักกรวดทรายตามคู่มือ');
  // เอสบีอาร์ทำปฏิกิริยาและตกตะกอนในถังเดียว จึงไม่มีถังตกตะกอนและไม่มีสายสูบกลับ
  assert.ok(!st('SBR').includes('clarifier') && !rec('SBR').includes('ras'), 'SBR ต้องไม่มีถังตกตะกอนและสายสูบกลับ');
  assert.ok(st('SBR').includes('holding'), 'SBR ต้องมีบ่อพักน้ำทิ้งรับน้ำที่ระบายเป็นกะ');
  // แผ่นหมุนชีวภาพเป็นฟิล์มติดที่ ต้องมีตกตะกอนทั้งสองขั้นแต่ไม่มีสายสูบกลับ
  assert.ok(st('RBC').includes('primary') && st('RBC').includes('clarifier') && !rec('RBC').includes('ras'), 'RBC ฟิล์มติดที่');
  // บึงประดิษฐ์แบบไหลผิวน้ำแบ่งสามส่วนตามชนิดพืช
  assert.deepEqual(st('CW').filter((x) => x.startsWith('wetland')), ['wetlandA', 'wetlandB', 'wetlandC'], 'CW ต้องมีสามส่วนพืช');
  assert.ok(!st('CW').includes('chlorine'), 'CW ไม่มีบ่อเติมคลอรีน');
  // ระบบไร้อากาศเป็นระบบอุตสาหกรรม ต้องเก็บก๊าซชีวภาพและมีหน่วยบำบัดขั้นหลัง
  for (const c of ['UASB', 'Anaerobic']) {
    assert.equal(PROCESS_TYPES[c].kind, 'industrial', c + ' ไม่ใช่ระบบชุมชนตามคู่มือ คพ.');
    assert.ok(rec(c).includes('gas') && st(c).includes('post'), c + ' ต้องมีสายก๊าซและหน่วยบำบัดขั้นหลัง');
  }
  // คู่มือ คพ. รับรองประเภทระบบชุมชนไว้ 5 ประเภท
  assert.deepEqual(PROCESS_CODES.filter((c) => PROCESS_TYPES[c].pcd_type === true).sort(), ['AL', 'AS', 'CW', 'RBC', 'SP'], 'คู่มือ คพ. จัดประเภทชุมชนไว้ 5 ประเภท');
  // คลองวนเวียนและเอสบีอาร์เป็นรูปแบบย่อยของแอกทิเวเต็ดสลัดจ์
  for (const c of ['OD', 'SBR']) assert.equal(PROCESS_TYPES[c].pcd_type, 'AS', c + ' เป็นรูปแบบย่อยของ AS');
  // บ่อดินไม่มีหน่วยจัดการตะกอน ใช้การขุดลอก
  for (const c of ['SP', 'AL']) {
    assert.equal((PROCESS_TYPES[c].sludge ?? []).length, 0, c + ' ไม่มีหน่วยจัดการตะกอน');
    assert.ok(rec(c).includes('dredge'), c + ' ใช้การขุดลอกตะกอนก้นบ่อ');
  }
});

test('จุดวัดบังคับตรงตามหลักการควบคุมและเกณฑ์ของ คพ.', () => {
  const has = (code, stage, param) => PROCESS_TYPES[code].monitor.some((m) => m.stage === stage && m.param === param);
  const pt = (code, stage, param) => PROCESS_TYPES[code].monitor.find((m) => m.stage === stage && m.param === param);
  assert.ok(has('AS', 'aeration', 'DO') && has('AS', 'aeration', 'MLSS'), 'AS ต้องวัด DO และ MLSS ในถังเติมอากาศ');
  assert.deepEqual(pt('AS', 'aeration', 'MLSS').target, [2500, 4000], 'MLSS ของ AS ตามเกณฑ์ คพ.');
  assert.deepEqual(pt('OD', 'ditch', 'MLSS').target, [3000, 6000], 'MLSS ของคลองวนเวียนตามเกณฑ์ คพ.');
  assert.deepEqual(pt('SBR', 'sbr', 'MLSS').target, [1500, 6000], 'MLSS ของเอสบีอาร์ตามเกณฑ์ คพ.');
  assert.ok(has('AS', 'clarifier', 'SBlanket'), 'AS ต้องวัดชั้นสลัดจ์ในถังตกตะกอน');
  assert.ok(has('AS', 'ras', 'Flow') && has('AS', 'was', 'Flow'), 'AS ต้องวัดอัตราสลัดจ์สูบกลับและสลัดจ์ส่วนเกิน');
  // คลอรีนคงเหลือตามเกณฑ์ คพ. 0.5 ถึง 1 มก./ล.
  for (const pair of [['AS', 'contact'], ['OD', 'contact'], ['AL', 'chlorine'], ['RBC', 'chlorine'], ['SBR', 'chlorine']]) {
    assert.ok(has(pair[0], pair[1], 'Cl2'), pair[0] + ' ต้องวัดคลอรีนคงเหลือที่ ' + pair[1]);
    assert.deepEqual(pt(pair[0], pair[1], 'Cl2').target, [0.5, 1], pair[0] + ' คลอรีนคงเหลือตามเกณฑ์ คพ.');
  }
  assert.ok(has('SBR', 'sbr', 'ORP') && has('SBR', 'sbr', 'Level'), 'SBR ต้องวัด ORP และระดับน้ำเพื่อคุมรอบ');
  assert.ok(has('MBR', 'membrane', 'TMP') && has('MBR', 'membrane', 'Tur'), 'MBR ต้องวัดความดันคร่อมเมมเบรนและความขุ่นน้ำกรอง');
  assert.ok(has('UASB', 'uasb', 'PH') && has('UASB', 'uasb', 'Temp') && has('UASB', 'gas', 'Biogas'), 'UASB ต้องวัด pH อุณหภูมิ และอัตราก๊าซ');
  assert.ok(has('CW', 'wetlandA', 'Level'), 'CW ต้องวัดระดับน้ำในบึงเพื่อจับการอุดตัน');
  assert.ok(has('IND', 'neutral', 'PH'), 'IND ต้องวัด pH ที่จุดปรับกรด-ด่าง');
  assert.ok(has('RBC', 'rbc', 'Watt'), 'RBC ต้องวัดกำลังไฟมอเตอร์เพลาเพราะเพลาชำรุดบ่อยตามที่คู่มือระบุ');
  // ทุกระบบชุมชนต้องวัดพารามิเตอร์ที่มาตรฐานน้ำทิ้งชุมชนคุมจริง
  for (const c of PROCESS_CODES.filter((x) => PROCESS_TYPES[x].kind === 'community')) {
    for (const p of ['eff:BOD', 'eff:TSS', 'PH']) assert.ok(has(c, 'outlet', p), c + ' ต้องวัด ' + p + ' ที่น้ำทิ้ง');
    assert.ok(has(c, 'outlet', 'eff:TN'), c + ' ต้องมีจุดวัดไนโตรเจนทั้งหมดตามมาตรฐานชุมชน');
  }
  // จุดวัดที่ระบบนั้นไม่มีทางมี
  assert.ok(!PROCESS_TYPES.RBC.monitor.some((m) => m.param === 'MLSS'), 'RBC เป็นฟิล์มติดที่ ไม่ต้องวัด MLSS');
  // เอสบีอาร์ระบายเป็นกะ ต้องใช้มาตรวัดในท่อ ไม่ใช่รางเปิด
  assert.equal(pt('SBR', 'outlet', 'Flow').sensor, 'Flow_em', 'SBR ต้องวัดน้ำออกด้วยมาตรแม่เหล็กไฟฟ้า');
  assert.equal(PROCESS_TYPES.SBR.monitor.filter((m) => m.stage === 'outlet' && m.param === 'Flow').length, 1, 'ต้องไม่มีจุดวัดน้ำออกซ้ำ');
});
