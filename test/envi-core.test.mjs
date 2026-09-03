// node --test test/*.test.mjs — ทดสอบฟังก์ชันบริสุทธิ์ (ไม่แตะ DOM / ไม่ต่อเน็ต)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../web/js/envi-core.js';
import { parseCsv, csvRowToEvent, csvRowToStation, makeBatches } from '../web/js/import.js';

test('makeBatches(): แบ่งตามจำนวนและขนาดไบต์ (ป่าจริม 1 MB ต้องไม่ไปรวมกับแปลงอื่นจนเกิน)', () => {
  const small = { a: 'x'.repeat(100) }, big = { a: 'y'.repeat(1_000_000) };
  const b = makeBatches([big, big, small, small, big], 3, 1_500_000);
  assert.deepEqual(b.map((x) => x.length), [1, 3, 1]);              // big สองตัวติดกันต้องแยกชุด
  assert.deepEqual(makeBatches([small, small, small, small], 3).map((x) => x.length), [3, 1]);
  assert.deepEqual(makeBatches([], 3), []);
});

test('num(): ค่าจากหน่วยงานเป็น string + sentinel ทุกแบบ = null', () => {
  assert.equal(core.num('37.5'), 37.5);
  assert.equal(core.num(12), 12);
  assert.equal(core.num('-1'), null);
  assert.equal(core.num(-999), null);
  assert.equal(core.num(''), null);
  assert.equal(core.num('-'), null);
  assert.equal(core.num('N/A'), null);
  assert.equal(core.num(null), null);
  assert.equal(core.num({ value: '18', aqi: '20' }), 18);   // Air4Thai ส่งเป็นอ็อบเจกต์
  assert.equal(core.num({ aqi: '20' }), 20);
  assert.equal(core.num('0'), 0);                            // ศูนย์จริงต้องไม่หาย
});

test('ceYear/parseThaiDate: พ.ศ. → ค.ศ. และเวลาไทย → UTC', () => {
  assert.equal(core.ceYear(2569), 2026);
  assert.equal(core.ceYear(2026), 2026);
  const d = core.parseThaiDate('2569-09-03', '10:00');
  assert.equal(d.toISOString(), '2026-09-03T03:00:00.000Z'); // 10:00 ไทย = 03:00 UTC
  assert.equal(core.parseThaiDate('3/9/2569').toISOString(), '2026-09-02T17:00:00.000Z');
  assert.equal(core.parseThaiDate('03-09-2026 23:30').toISOString(), '2026-09-03T16:30:00.000Z');
  assert.equal(core.parseThaiDate('ไม่ใช่วันที่'), null);
  assert.equal(core.parseThaiDate(''), null);
});

test('todayISO(): วันไทย ไม่ใช่ UTC (ตีหนึ่งไทยยังเป็นวันใหม่)', () => {
  assert.equal(core.todayISO(new Date('2026-09-02T18:30:00Z')), '2026-09-03');
  assert.equal(core.todayISO(new Date('2026-09-02T16:59:00Z')), '2026-09-02');
});

test('aqiLevel/pm25Level/stationColor', () => {
  assert.equal(core.aqiLevel(20).label, 'ดีมาก');
  assert.equal(core.aqiLevel(75).label, 'ปานกลาง');
  assert.equal(core.aqiLevel(250).label, 'มีผลกระทบต่อสุขภาพ');
  assert.equal(core.aqiLevel(null).index, -1);
  assert.equal(core.pm25Level(37.5).label, 'ปานกลาง');
  assert.equal(core.pm25Level(37.6).label, 'เริ่มมีผลกระทบต่อสุขภาพ');
  assert.equal(core.stationColor({ AQI: { value: 20 } }), core.aqiLevel(20).color);
  assert.equal(core.stationColor({ PM25: { value: 80 } }), core.pm25Level(80).color);
  assert.equal(core.stationColor({}), '#9e9e9e');
});

test('moduleTemp(): King/Sandia ให้ค่าเท่าไฟล์ V2.9.0 (Meteonorm mock: 860 W/m², 1.2 m/s, 34.8 °C)', () => {
  const t = core.moduleTemp({ instantGhi: 860, windSpeed: 1.2, airTemp: 34.8 });
  const expected = 860 * Math.exp(-3.47 + -0.0594 * 1.2) + 34.8 + (860 / 1000) * 3;
  assert.ok(Math.abs(t - expected) < 1e-9);
  assert.equal(core.interpretModuleTemp(t).style, 'danger');
  assert.equal(core.interpretGHI(1965).style, 'good');
  assert.equal(core.interpretDiffuse(815, 1965).style, 'good');
});

test('cacheKey(): ปัด 2 ตำแหน่ง ตรงกับ site_report() ฝั่ง SQL', () => {
  assert.equal(core.cacheKey('nasa_power', 14.018951, 100.557727), 'nasa_power:14.02,100.56');
  assert.equal(core.cacheKey('nasa_power', 13.75, 100.5), 'nasa_power:13.75,100.50');
});

test('parseCoords(): รองรับช่องว่าง/สลับลำดับ/ปฏิเสธค่าเพี้ยน', () => {
  assert.deepEqual(core.parseCoords('14.0189, 100.5577'), { lat: 14.0189, lng: 100.5577 });
  assert.deepEqual(core.parseCoords('100.5577 14.0189'), { lat: 14.0189, lng: 100.5577 });
  assert.equal(core.parseCoords('abc'), null);
  assert.equal(core.parseCoords('95, 200'), null);
});

test('summarizeNasaPower(): รวมรายวันเป็นรายปี ข้าม -999', () => {
  const j = { properties: { parameter: {
    ALLSKY_SFC_SW_DWN: { 20250101: 5, 20250102: 6, 20250103: -999 },
    ALLSKY_SFC_SW_DIFF: { 20250101: 2, 20250102: 2 },
    T2M: { 20250101: 30, 20250102: 32 }, WS2M: { 20250101: 1, 20250102: 2 }, RH2M: { 20250101: 60 },
  } } };
  const s = core.summarizeNasaPower(j, 2025);
  assert.equal(s.ghi, 11); assert.equal(s.diffuse, 4); assert.equal(s.airTemp, 31); assert.equal(s.windSpeed, 1.5);
  assert.equal(s.days, 3);
});

test('summarizePvgis(): เลือกชั่วโมงตามเดือน/ชั่วโมง', () => {
  const j = { outputs: { hourly: [
    { time: '20200601:1210', 'G(i)': 800, T2m: 33, WS10m: 2 },
    { time: '20200602:1210', 'G(i)': 600, T2m: 31, WS10m: 1 },
    { time: '20200601:1310', 'G(i)': 900, T2m: 34, WS10m: 2 },
  ] } };
  const s = core.summarizePvgis(j, 6, 12);
  assert.equal(s.instantGhi, 700); assert.equal(s.airTemp, 32); assert.equal(s.samples, 2);
});

test('formatThaiAddress(): ประกอบ ต./อ./จ. เท่าที่มี', () => {
  assert.equal(core.formatThaiAddress({ subdistrict: 'คลองหนึ่ง', district: 'คลองหลวง', province: 'ปทุมธานี' }), 'ต.คลองหนึ่ง อ.คลองหลวง จ.ปทุมธานี');
  // Nominatim จริงส่งคำนำหน้าเต็มมา (เจอ 3 ก.ย. 2569) — ต้องไม่ได้ "อ.อำเภอเมือง"
  assert.equal(core.formatThaiAddress({ subdistrict: 'ตำบลบ้านกลาง', district: 'อำเภอเมืองปทุมธานี', province: 'จังหวัดปทุมธานี' }), 'ต.บ้านกลาง อ.เมืองปทุมธานี จ.ปทุมธานี');
  assert.equal(core.formatThaiAddress({ quarter: 'แขวงสีลม', city_district: 'เขตบางรัก', state: 'กรุงเทพมหานคร' }), 'แขวงสีลม เขตบางรัก กรุงเทพมหานคร');
  assert.equal(core.formatThaiAddress(null), null);
});

test('summarizeReport(): สรุปทุกหมวดเป็นประโยค รองรับหมวดว่าง', () => {
  const lines = core.summarizeReport({ air: null, hotspots_7d_10km: { count: 3 }, quakes_30d_300km: { count: 0 }, layer_hits: [{ layer: 'ป่าสงวน', feature: 'ป่าเขาใหญ่' }] });
  assert.ok(lines.find((l) => l.key === 'air').text.includes('ไม่มีสถานี'));
  assert.ok(lines.find((l) => l.key === 'hotspot').text.includes('3 จุด'));
  assert.ok(lines.find((l) => l.key === 'layers').text.includes('ป่าเขาใหญ่'));
  assert.deepEqual(core.summarizeReport(null), []);
});

test('windDir()/summarizeForecast(): ทิศลม 8 ทิศ และสรุปฝน/อุณหภูมิ 24 ชม. จากโครง TMD NWP', () => {
  assert.equal(core.windDir(0), 'น'); assert.equal(core.windDir(90), 'ตอ'); assert.equal(core.windDir(265), 'ต'); assert.equal(core.windDir(null), '—');
  const fc = { hourly: [
    { time: '2026-09-03T14:00:00+07:00', tc: 35.1, rain: 0, cond: 3 },
    { time: '2026-09-03T15:00:00+07:00', tc: 36.3, rain: 0, cond: 3 },
    { time: '2026-09-03T16:00:00+07:00', tc: 31.0, rain: 2.4, cond: 6 },
    { time: '2026-09-03T17:00:00+07:00', tc: 29.5, rain: 0.2, cond: 8 },
  ] };
  const s = core.summarizeForecast(fc);
  assert.equal(s.rain_mm, 2.6); assert.equal(s.rainy_hours, 2); assert.equal(s.tc_min, 29.5); assert.equal(s.tc_max, 36.3);
  assert.equal(s.first_rain, '2026-09-03T16:00:00+07:00');
  assert.equal(core.summarizeForecast({ hourly: [] }), null);
});

test('parseCsv(): BOM, เครื่องหมายคำพูด, คอมมาในค่า, บรรทัดว่าง', () => {
  const rows = parseCsv('﻿lat,long,ชื่อ,date\n18.1,98.9,"บ้านแม่, สาย",3/9/2562\n\n19.0,99.0,ดอย,2019-09-04\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['ชื่อ'], 'บ้านแม่, สาย');
  const ev = csvRowToEvent(rows[0]);
  assert.equal(ev.lat, 18.1); assert.equal(ev.lng, 98.9); assert.equal(ev.title, 'บ้านแม่, สาย');
  assert.equal(ev.occurred_at, '2019-09-02T17:00:00.000Z');       // พ.ศ. 2562 → 2019
  assert.equal(csvRowToEvent({ ชื่อ: 'ไม่มีพิกัด' }), null);
  const st = csvRowToStation({ id: 'S1', name: 'สถานี', lat: '13.7', lon: '100.5', extra: 'x' });
  assert.equal(st.ext_id, 'S1'); assert.deepEqual(st.meta, { extra: 'x' });
});

test('withCache(): อ่านแคชสดเมื่อยังไม่หมดอายุ · เรียก fn เมื่อไม่มี · เขียนไม่ได้ก็ไม่ล้ม', async () => {
  const store = new Map([['k1', { payload: { v: 1 }, fetched_at: new Date().toISOString() }]]);
  const fake = {
    from: () => ({
      select: () => ({ eq: (_c, k) => ({ maybeSingle: async () => ({ data: store.get(k) ?? null }) }) }),
      upsert: async () => { throw new Error('anon เขียนไม่ได้'); },
    }),
  };
  core.__setClient(fake);
  const a = await core.withCache('k1', async () => ({ v: 99 }));
  assert.equal(a.cached, true); assert.equal(a.payload.v, 1);
  const b = await core.withCache('k2', async () => ({ v: 2 }));
  assert.equal(b.cached, false); assert.equal(b.payload.v, 2);
});
