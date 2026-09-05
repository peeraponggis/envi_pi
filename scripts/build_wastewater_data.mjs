/**
 * รวมข้อมูลระบบบำบัดน้ำเสียจาก 3 แหล่งราชการ → web/data/wastewater.json (สแนปช็อตสำหรับหน้า web/wastewater.html)
 *
 *   node scripts/build_wastewater_data.mjs            → อ่านไฟล์ที่มีใน data/raw/
 *   node scripts/build_wastewater_data.mjs --fetch    → ดาวน์โหลดใหม่ก่อน (DSPOT HTML, ONEP CSV, กทม. CSV)
 *
 * แหล่ง (ตรวจ 5 ก.ย. 2569):
 *   1. DSPOT กรมควบคุมมลพิษ https://dspot.pcd.go.th/database/s?area=   — Next.js ฝัง __NEXT_DATA__.props.pageProps.reports (216 ระบบ, lat/lng, รายงานปี 2568)
 *      JSON ตรง: https://dspot.pcd.go.th/_next/data/<buildId>/database/s.json?area=   (buildId เปลี่ยนทุก deploy · ไม่มี CORS → ต้องผ่าน Edge)
 *   2. กทม. data.bangkok.go.th "บ่อบำบัดน้ำเสีย" wastewater.csv (โรงควบคุมคุณภาพน้ำ 7 แห่ง พิกัด UTM 47N)
 *   3. สผ. https://www.onep.go.th/data/wastewater-treatment-system.csv (ระบบที่ได้เงินอุดหนุน 106 ระบบ ไม่มีพิกัด → ผูกศูนย์กลางตำบล/อำเภอ จาก data/raw/tambon_rows.json)
 */
import fs from 'node:fs';

const RAW = 'data/raw', OUT = 'web/data/wastewater.json';
const UA = { 'User-Agent': 'Mozilla/5.0 envi-pi/1.0' };
const fetchText = async (url, file) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(`${RAW}/${file}`, buf);
  return buf;
};

if (process.argv.includes('--fetch')) {
  await fetchText('https://dspot.pcd.go.th/database/s?area=', 'dspot_list.html');
  await fetchText('https://www.onep.go.th/data/wastewater-treatment-system.csv', 'onep_wwtp.csv');
  await fetchText('https://data.bangkok.go.th/dataset/71dabe2a-5888-4d11-a789-0d67a3dc6ade/resource/4e102732-dbcf-41c5-b297-557116e0f5f9/download/wastewater.csv', 'bkk_wastewater.csv');
  console.log('ดาวน์โหลดใหม่แล้ว');
}

const num = (v) => { const s = String(v ?? '').replace(/,/g, '').trim(); if (!s || s === '-' || isNaN(+s)) return null; return +s; };
const norm = (s) => String(s ?? '').replace(/^(ต\.|อ\.|จ\.|ตำบล|อำเภอ|จังหวัด|แขวง|เขต)\s*/, '').replace(/\s+/g, '').trim();
const csv = (text) => {                                            // CSV parser เล็ก ๆ รองรับ quote
  const rows = [], re = /("([^"]|"")*"|[^,\r\n]*)(,|\r?\n|$)/g; let row = [], m;
  while ((m = re.exec(text)) && m[0] !== '') { row.push(m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]); if (m[3] !== ',') { rows.push(row); row = []; } }
  const [h, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k.trim(), r[i] ?? ''])));
};

// ── 1. DSPOT ────────────────────────────────────────────────────────────────
const html = fs.readFileSync(`${RAW}/dspot_list.html`, 'utf8');
const nd = JSON.parse(html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)[1]);
const reports = nd.props.pageProps.reports;
const dspot = reports.filter((r) => r.lat && r.lng).map((r) => ({
  id: r.plant_id, name: r.plant_name, local: r.local_name, level: r.level_gov, province: r.province, zone: r.zone, region: r.region,
  lat: +r.lat, lng: +r.lng, manage: r.manage_type, status: r.wwt_status, type: r.plant_type ?? null, operator: r.unit_op ?? null,
  capacity: num(r.capacity), inflow_pct: num(r.p_inflow), avg_inflow: num(r.avg_collect_waste), year_op: num(r.year_op),
  pop: num(r.total_pop), service_pct: num(r.p_service_area), basin: r.basin || null, river: r.river || null, discharge: r.discharge_place || null,
  cost_mb: num(r.total_const_cost), fund: r.unit_fund || null, location: r.location || null, report_year: r.report_year,
  wq: { date: r.date_quality || null, bod_in: num(r.bod_inflow), bod_out: num(r.bod_discharge), tss_in: num(r.tss_inflow), tss_out: num(r.tss_discharge),
        ph_in: num(r.ph_inflow), ph_out: num(r.ph_discharge), tn_in: num(r.tn_inflow), tn_out: num(r.tn_discharge), tp_in: num(r.tp_inflow), tp_out: num(r.tp_discharge) },
  fee: r.fee_charge || null, remark: r.remark_general || null,
}));

// ── 2. กทม. (UTM zone 47N → WGS84) ─────────────────────────────────────────
function utmToLatLng(x, y, zone = 47) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e = Math.sqrt(f * (2 - f)), e1sq = e * e / (1 - e * e);
  x -= 500000; const M = y / k0, mu = M / (a * (1 - e ** 2 / 4 - 3 * e ** 4 / 64 - 5 * e ** 6 / 256)), e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const phi = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const N = a / Math.sqrt(1 - (e * Math.sin(phi)) ** 2), T = Math.tan(phi) ** 2, C = e1sq * Math.cos(phi) ** 2, R = a * (1 - e * e) / (1 - (e * Math.sin(phi)) ** 2) ** 1.5, D = x / (N * k0);
  const lat = phi - (N * Math.tan(phi) / R) * (D * D / 2 - (5 + 3 * T + 10 * C - 4 * C * C - 9 * e1sq) * D ** 4 / 24 + (61 + 90 * T + 298 * C + 45 * T * T - 252 * e1sq - 3 * C * C) * D ** 6 / 720);
  const lng = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180 + (D - (1 + 2 * T + C) * D ** 3 / 6 + (5 - 2 * C + 28 * T - 3 * C * C + 8 * e1sq + 24 * T * T) * D ** 5 / 120) / Math.cos(phi);
  return [+(lat * 180 / Math.PI).toFixed(6), +(lng * 180 / Math.PI).toFixed(6)];
}
const bkk = csv(fs.readFileSync(`${RAW}/bkk_wastewater.csv`, 'utf8').replace(/^﻿/, '')).filter((r) => num(r.X) && num(r.Y)).map((r) => {
  const [lat, lng] = utmToLatLng(num(r.X), num(r.Y));
  return { id: 'bkk-' + r.OBJECTID, name: r.NAME, lat, lng, capacity: num((r.VOLUME.match(/[\d,]+/) || [''])[0]), area: r.AREA, pipe_km: r.LENGTH,
           service: r.SERVICE, location: r.LOCATION, discharge: r.SEWAGE, dcode: r.DCODE };
});

// ── 3. สผ. (geocode ตำบล/อำเภอ) ────────────────────────────────────────────
const tam = JSON.parse(fs.readFileSync(`${RAW}/tambon_rows.json`, 'utf8'));
const byT = new Map(), byA = new Map();
for (const t of tam) {
  const p = norm(t.province), a = norm(t.meta?.amphoe_th), n = norm(t.name_th);
  if (!byT.has(`${p}|${n}`)) byT.set(`${p}|${n}`, t);
  (byA.get(`${p}|${a}`) ?? byA.set(`${p}|${a}`, []).get(`${p}|${a}`)).push(t);
}
const cen = (arr) => [arr.reduce((s, x) => s + x.lat, 0) / arr.length, arr.reduce((s, x) => s + x.lng, 0) / arr.length];
const onepStat = { tambon: 0, amphoe: 0, none: 0 };
const onep = csv(fs.readFileSync(`${RAW}/onep_wwtp.csv`, 'utf8').replace(/^﻿/, '')).map((r) => {
  const p = norm(r['จังหวัด']), loc = r['ที่ตั้ง'] || '';
  const mt = loc.match(/(?:ต\.|ตำบล|แขวง)\s*([^\s,]+)/), ma = loc.match(/(?:อ\.|อำเภอ|เขต)\s*([^\s,]+)/);
  let lat = null, lng = null, geocode = 'none';
  const hit = mt && byT.get(`${p}|${norm(mt[1])}`);
  if (hit) { [lat, lng, geocode] = [hit.lat, hit.lng, 'tambon']; }
  else if (ma && byA.has(`${p}|${norm(ma[1])}`)) { [lat, lng] = cen(byA.get(`${p}|${norm(ma[1])}`)); geocode = 'amphoe'; }
  onepStat[geocode]++;
  return { id: 'onep-' + r['ที่'], agency: r['หน่วยงานรับผิดชอบ'], province: r['จังหวัด'], region: r['ภาค'], location: loc, type_code: r['ชื่อย่อของระบบ'],
           type: r['ประเภทของระบบ'], year_budget: num(r['ปีที่ได้รับงบประมาณ']), year_op: num(r['ปีที่เปิดใช้งาน']), status: (r['สถานภาพปัจจุบัน'] || '').trim(),
           capacity: num(r['รองรับน้ำเสีย (ลบ.ม/วัน)']), fund: r['แหล่งงบประมาณ'], lat: lat && +lat.toFixed(5), lng: lng && +lng.toFixed(5), geocode };
});

const out = {
  built_at: new Date().toISOString(),
  sources: {
    pcd_dspot: { agency: 'กรมควบคุมมลพิษ (DSPOT)', url: 'https://dspot.pcd.go.th/database/s?area=', json: `https://dspot.pcd.go.th/_next/data/${nd.buildId}/database/s.json?area=`,
                 build_id: nd.buildId, report_year: reports[0]?.report_year ?? null, count: dspot.length, note: 'ฝังใน __NEXT_DATA__ · ไม่มี CORS · buildId เปลี่ยนเมื่อ deploy' },
    bma_wwtp: { agency: 'กรุงเทพมหานคร สำนักการระบายน้ำ', url: 'https://data.bangkok.go.th/dataset/http-bitly-ws-sk3a', count: bkk.length, note: 'พิกัด UTM 47N แปลงเป็น WGS84 · ปริมาณบำบัดรายเดือนอยู่ชุด report-plant-qwater' },
    onep_pap: { agency: 'สำนักงานนโยบายและแผนทรัพยากรธรรมชาติและสิ่งแวดล้อม (สผ.)', url: 'https://data.go.th/dataset/gdpublish-pap1', csv: 'https://www.onep.go.th/data/wastewater-treatment-system.csv',
                count: onep.length, geocode: onepStat, note: 'ไม่มีพิกัด → ศูนย์กลางตำบล/อำเภอ' },
  },
  dspot, bkk, onep,
};
fs.mkdirSync('web/data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

// ── SQL นำเข้า กทม. + สผ. เป็น stations (รันใน SQL Editor ได้เลย รันซ้ำได้) ──
// DSPOT ไม่อยู่ในไฟล์นี้เพราะ Edge handler pcd_dspot ดึงเองทุกสัปดาห์
const stRows = [
  ...bkk.map((r) => ({ source_id: 'bma_wwtp', ext_id: r.id.replace('bkk-', ''), name_th: r.name, area_th: r.location, province: 'กรุงเทพมหานคร', station_type: 'wwtp', lat: r.lat, lng: r.lng,
    meta: { status: 'เดินระบบ', manage_type: 'ระบบบำบัดน้ำเสียรวมของชุมชน', operator: 'กทม.', capacity: r.capacity, service: r.service, pipe_km: r.pipe_km, area: r.area, discharge: r.discharge, dcode: r.dcode, zone: 'กลาง' } })),
  ...onep.filter((r) => r.lat && r.lng).map((r) => ({ source_id: 'onep_pap', ext_id: r.id.replace('onep-', ''), name_th: r.agency, area_th: r.location, province: r.province, station_type: 'wwtp', lat: r.lat, lng: r.lng,
    meta: { status: r.status, type_code: r.type_code, plant_type: r.type_code, type: r.type, capacity: r.capacity, year_budget: r.year_budget, year_op: r.year_op, fund: r.fund, region: r.region, zone: r.region, geocode: r.geocode } })),
];
const sql = `-- สร้างโดย scripts/build_wastewater_data.mjs เมื่อ ${out.built_at} — stations ระบบบำบัดน้ำเสีย กทม. ${bkk.length} + สผ. ${stRows.length - bkk.length} (สผ. ที่ไม่มีพิกัด ${onepStat.none} ระบบไม่รวม)
-- รันซ้ำได้ (upsert ตาม source_id, ext_id) · ต้องรัน migration 1100 ก่อน (sources bma_wwtp/onep_pap)
insert into public.stations (source_id, ext_id, name_th, area_th, province, station_type, lat, lng, meta)
select x.source_id, x.ext_id, x.name_th, x.area_th, x.province, x.station_type, x.lat, x.lng, x.meta
  from jsonb_to_recordset($j$${JSON.stringify(stRows).replace(/\$j\$/g, '')}$j$::jsonb)
    as x(source_id text, ext_id text, name_th text, area_th text, province text, station_type text, lat double precision, lng double precision, meta jsonb)
on conflict (source_id, ext_id) do update set
  name_th = excluded.name_th, area_th = excluded.area_th, province = excluded.province, station_type = excluded.station_type,
  lat = excluded.lat, lng = excluded.lng, meta = excluded.meta, active = true;
select source_id, count(*) as stations, sum((meta->>'capacity')::numeric) as capacity_m3d from public.stations where source_id in ('bma_wwtp', 'onep_pap', 'pcd_dspot') group by 1 order by 1;
`;
fs.mkdirSync('supabase/seed', { recursive: true });
fs.writeFileSync('supabase/seed/wastewater_stations.sql', sql);
console.log(`เขียน supabase/seed/wastewater_stations.sql · ${stRows.length} แถว`);
console.log(`เขียน ${OUT} · DSPOT ${dspot.length} · กทม. ${bkk.length} · สผ. ${onep.length} (geocode`, onepStat, `) · buildId ${nd.buildId}`);
