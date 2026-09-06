import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCESS_TYPES, PROCESS_CODES, SENSOR_TYPES, BRAND_EXAMPLES, ALL_PARAM_INFO, STAGES, sensorFor, designSystem, powerBudget, plantEnergy,
  measuredIntensity, solarSizing, batterySizing, pshFromDede, makeSeries, summarizeSeries, payloadFor, designToURL, designFromURL, levelFor,
} from '../web/js/sensor-catalog.js';

test('ทุกชนิดระบบมี stage/monitor ครบ และพารามิเตอร์ทุกตัวมีคำอธิบาย + เซนเซอร์รองรับ', () => {
  for (const code of PROCESS_CODES) {
    const p = PROCESS_TYPES[code];
    assert.ok(p.stages.length >= 4, code + ' stages');
    for (const s of p.stages) assert.ok(STAGES[s], `${code}: ไม่รู้จัก stage ${s}`);
    assert.ok(p.monitor.some((m) => m.required), code + ' ต้องมีจุดวัดบังคับ');
    for (const m of p.monitor) {
      assert.ok(ALL_PARAM_INFO[m.param], `${code}: ไม่มีคำอธิบาย ${m.param}`);
      assert.ok(p.stages.includes(m.stage) || m.stage === 'plant', `${code}: stage ${m.stage} ไม่อยู่ในกระบวนการ`);
      assert.ok(sensorFor(m.param, m.stage), `${code}: ไม่มีเซนเซอร์สำหรับ ${m.param}`);
    }
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
