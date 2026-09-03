/**
 * แปลงทะเบียน EIA (eia_list.json + eia_detail.json จาก scrape_eia.mjs) เป็นแถวสำหรับ RPC import_events
 *
 *   node scripts/build_eia_rows.mjs  → data/raw/eia_events_rows.json
 *
 * พิกัด = ศูนย์กลางตำบล (dopa_tambon: data/raw/tambon_rows.json) · ไม่เจอตำบล → เฉลี่ยตำบลในอำเภอ · ไม่เจออำเภอ → เฉลี่ยจังหวัด
 * จังหวัดหาย (ที่ตั้งเขียนแค่ "ตำบลX อำเภอY") → เดาจังหวัดจากชื่ออำเภอ (อำเภอที่ชื่อไม่ซ้ำทั้งประเทศ) หรือชื่อตำบล+อำเภอ
 * occurred_at = วันที่แจ้งเห็นชอบ (พ.ศ. → ค.ศ.) · ext_id = id ของ Smart EIA
 */
import fs from 'node:fs';

const norm = (s) => String(s ?? '').replace(/^(ต\.|อ\.|จ\.|ตำบล|อำเภอ|จังหวัด|แขวง|เขต)\s*/, '').replace(/\s+/g, '').trim();
const tam = JSON.parse(fs.readFileSync('data/raw/tambon_rows.json', 'utf8'));
const byTam = new Map(), byAmp = new Map(), byProv = new Map(), ampProv = new Map();
for (const t of tam) {
  const p = norm(t.province), a = norm(t.meta?.amphoe_th), n = norm(t.name_th);
  if (!byTam.has(`${p}|${a}|${n}`)) byTam.set(`${p}|${a}|${n}`, t);
  if (!byTam.has(`${p}|${n}`)) byTam.set(`${p}|${n}`, t);
  (byAmp.get(`${p}|${a}`) ?? byAmp.set(`${p}|${a}`, []).get(`${p}|${a}`)).push(t);
  (byProv.get(p) ?? byProv.set(p, []).get(p)).push(t);
  (ampProv.get(a) ?? ampProv.set(a, new Set()).get(a)).add(p);
  (ampProv.get(`${a}|${n}`) ?? ampProv.set(`${a}|${n}`, new Set()).get(`${a}|${n}`)).add(p);
}
const cen = (arr) => [arr.reduce((s, x) => s + x.lat, 0) / arr.length, arr.reduce((s, x) => s + x.lng, 0) / arr.length];
const thDate = (s) => { const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return null; let y = +m[3]; if (y > 2400) y -= 543; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00+07:00`; };

const list = JSON.parse(fs.readFileSync('data/raw/eia_list.json', 'utf8'));
const det = JSON.parse(fs.readFileSync('data/raw/eia_detail.json', 'utf8'));
const stats = { tambon: 0, amphoe: 0, province: 0, none: 0, no_detail: 0, guessed_prov: 0 };
const rows = [];
for (const it of list) {
  const d = det[it.id];
  if (!d || d.error) { stats.no_detail++; continue; }
  let p = norm(d.province), a = norm(d.amphoe), t = norm(d.tambon);
  if (!p && a) {                                       // เดาจังหวัดจากอำเภอ(+ตำบล) ที่ไม่ซ้ำ
    const cands = ampProv.get(`${a}|${t}`) ?? ampProv.get(a);
    if (cands && cands.size === 1) { p = [...cands][0]; stats.guessed_prov++; }
  }
  if (!p && t) { const c = [...ampProv.entries()].filter(([k]) => k.endsWith('|' + t)).flatMap(([, v]) => [...v]); if (new Set(c).size === 1) { p = c[0]; stats.guessed_prov++; } }
  let lat, lng, lvl;
  const hit = (p && t && (byTam.get(`${p}|${a}|${t}`) || byTam.get(`${p}|${t}`))) || null;
  if (hit) { [lat, lng, lvl] = [hit.lat, hit.lng, 'tambon']; }
  else if (p && a && byAmp.has(`${p}|${a}`)) { [lat, lng] = cen(byAmp.get(`${p}|${a}`)); lvl = 'amphoe'; }
  else if (p && byProv.has(p)) { [lat, lng] = cen(byProv.get(p)); lvl = 'province'; }
  else { stats.none++; continue; }
  stats[lvl]++;
  rows.push({
    ext_id: String(it.id), occurred_at: thDate(d.approval_date || it.approval_date),
    lat: +lat.toFixed(5), lng: +lng.toFixed(5), title: it.name.slice(0, 200), province: d.province || p || null,
    props: { category: d.category || it.category, subcategory: d.subcategory, report_type: d.report_type, report_no: it.report_no,
      status: it.status, project_status: d.project_status, approval_no: it.approval_no, approval_date: d.approval_date || it.approval_date,
      owner: d.owner, consultant: d.consultant, location: d.location, tambon: d.tambon, amphoe: d.amphoe, geocode: lvl },
  });
}
fs.writeFileSync('data/raw/eia_events_rows.json', JSON.stringify(rows));
console.log(`โครงการ ${list.length} · มีรายละเอียด ${list.length - stats.no_detail} · เขียน ${rows.length} แถว · geocode`, stats);
