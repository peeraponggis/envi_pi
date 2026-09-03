/**
 * import.js — หน้า admin/editor นำเข้าไฟล์นิ่ง (GeoJSON / CSV) ผ่าน RPC import_*
 *
 * ทำไมส่งเป็นชุด: layer_features ของป่าสงวน 1,221 แปลงหลาย MB — ส่งทีเดียวเกิน payload
 * ทำไมรายงานเป็นตัวเลข: งานหลายขยักต้องบอกว่าขยักไหนผ่าน ไม่ใช่ ok/ไม่ ok (บทเรียนจาก pi_crm_erp)
 */
import * as core from './envi-core.js';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += '\n' + m; el.scrollTop = el.scrollHeight; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** CSV UTF-8 (มี/ไม่มี BOM) → array of objects — รองรับเครื่องหมายคำพูดและคอมมาในค่า */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() ?? []).map((h) => h.trim());
  return rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const KEYS = {
  lat: ['lat', 'latitude', 'ละติจูด', 'y'], lng: ['lng', 'long', 'lon', 'longitude', 'ลองจิจูด', 'x'],
  date: ['occurred_at', 'date', 'datetime', 'วันที่', 'event_date'], title: ['title', 'name', 'name_th', 'ชื่อ', 'location'],
  province: ['province', 'จังหวัด', 'prov', 'changwat'], magnitude: ['magnitude', 'mag', 'frp', 'severity'],
  ext: ['ext_id', 'id', 'code', 'รหัส', 'no'], name_en: ['name_en', 'name_eng'], area: ['area_th', 'area', 'ที่ตั้ง', 'address'],
  type: ['station_type', 'type'],
};
function pick(o, keys) {
  const lower = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) { const v = lower[k.toLowerCase()]; if (v !== undefined && v !== '') return v; }
  return undefined;
}
function rest(o, used) {
  const usedLower = new Set(used.flat().map((k) => k.toLowerCase()));
  return Object.fromEntries(Object.entries(o).filter(([k]) => !usedLower.has(k.toLowerCase())));
}

export function csvRowToEvent(r) {
  const lat = core.num(pick(r, KEYS.lat)), lng = core.num(pick(r, KEYS.lng));
  if (lat === null || lng === null) return null;
  const d = core.parseThaiDate(pick(r, KEYS.date));
  return {
    ext_id: pick(r, KEYS.ext) ?? null, occurred_at: d ? d.toISOString() : null, lat, lng,
    magnitude: core.num(pick(r, KEYS.magnitude)), title: pick(r, KEYS.title) ?? null, province: pick(r, KEYS.province) ?? null,
    props: rest(r, [KEYS.lat, KEYS.lng, KEYS.date, KEYS.title, KEYS.province, KEYS.magnitude, KEYS.ext]),
  };
}
export function csvRowToStation(r) {
  const lat = core.num(pick(r, KEYS.lat)), lng = core.num(pick(r, KEYS.lng));
  if (lat === null || lng === null) return null;
  return {
    ext_id: pick(r, KEYS.ext) ?? pick(r, KEYS.title) ?? `${lat},${lng}`, name_th: pick(r, KEYS.title) ?? null,
    name_en: pick(r, KEYS.name_en) ?? null, area_th: pick(r, KEYS.area) ?? null, province: pick(r, KEYS.province) ?? null,
    station_type: pick(r, KEYS.type) ?? null, lat, lng,
    meta: rest(r, [KEYS.lat, KEYS.lng, KEYS.title, KEYS.name_en, KEYS.area, KEYS.province, KEYS.type, KEYS.ext]),
  };
}

/** แบ่งชุดตามจำนวน **และ** ขนาดไบต์ — โพลิกอนป่าสงวนบางแปลงใหญ่ 1 MB (ป่าจริม) ส่ง 200 แปลงทีเดียวไม่ไหว */
export function makeBatches(items, size, maxBytes = 1_500_000) {
  const out = []; let cur = [], bytes = 0;
  for (const it of items) {
    const b = JSON.stringify(it).length;
    if (cur.length && (cur.length >= size || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(it); bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function rpcBatches(name, buildArgs, items, size) {
  const sb = await core.getClient();
  let inserted = 0, skipped = 0; const errors = [];
  const batches = makeBatches(items, size);
  for (let i = 0; i < batches.length; i++) {
    const part = batches[i];
    const { data, error } = await sb.rpc(name, buildArgs(part));
    if (error) { errors.push(error.message); log(`  ชุด ${i + 1}: ล้ม — ${error.message}`); continue; }
    inserted += data.inserted; skipped += data.skipped;
    if (data.errors?.length) errors.push(...data.errors);
    log(`  ชุด ${i + 1}/${batches.length}: เข้า ${data.inserted} ข้าม ${data.skipped}`);
  }
  log(`สรุป: เข้า ${inserted} · ข้าม ${skipped}${errors.length ? ' · ตัวอย่างข้อผิดพลาด: ' + [...new Set(errors)].slice(0, 3).join(' | ') : ''}`);
  return { inserted, skipped };
}

async function importLayer() {
  const id = $('layerId').value.trim(), name = $('layerName').value.trim(), file = $('layerFile').files[0];
  if (!/^[a-z0-9_]+$/.test(id) || !name || !file) { log('กรอกรหัสชั้น (a-z0-9_) ชื่อชั้น และเลือกไฟล์'); return; }
  const gj = JSON.parse(await file.text());
  const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : null;
  if (!feats) { log('ไฟล์ไม่ใช่ GeoJSON FeatureCollection'); return; }
  const sb = await core.getClient();
  const { error } = await sb.from('layers').upsert({ id, name_th: name, source_id: $('layerSource').value || null, geom_type: feats[0]?.geometry?.type ?? 'MultiPolygon' });
  if (error) { log('สร้าง layers ไม่ได้: ' + error.message); return; }
  log(`ชั้น ${id}: ${feats.length} ฟีเจอร์ — กำลังส่ง…`);
  await rpcBatches('import_features', (part) => ({ p_layer: id, p_features: part, p_name_key: $('layerNameKey').value.trim() || 'name', p_ext_key: $('layerExtKey').value.trim() || null }), feats, 200);
}

async function importEvents() {
  const file = $('evFile').files[0]; if (!file) { log('เลือกไฟล์ CSV'); return; }
  const rows = parseCsv(await file.text()).map(csvRowToEvent);
  const ok = rows.filter(Boolean);
  log(`CSV ${rows.length} แถว · มีพิกัด ${ok.length} · ไม่มีพิกัด ${rows.length - ok.length} (ข้าม)`);
  await rpcBatches('import_events', (part) => ({ p_source: $('evSource').value, p_kind: $('evKind').value, p_rows: part }), ok, 500);
}

async function importStations() {
  const file = $('stFile').files[0]; if (!file) { log('เลือกไฟล์ CSV'); return; }
  const rows = parseCsv(await file.text()).map(csvRowToStation);
  const ok = rows.filter(Boolean);
  log(`CSV ${rows.length} แถว · มีพิกัด ${ok.length}`);
  await rpcBatches('import_stations', (part) => ({ p_source: $('stSource').value, p_rows: part }), ok, 500);
}

async function refresh() {
  const p = await core.myProfile().catch(() => null);
  const can = p && core.canImport(p.role);
  $('userBox').innerHTML = p ? `${esc(p.email)} (${esc(p.role)}) <button class="btn-sm" id="btnLogout">ออก</button>${can ? '' : ' <span class="err">บทบาทนี้นำเข้าไม่ได้ — ให้ admin ตั้ง role เป็น editor</span>'}`
                             : '<button class="btn-sm" id="btnLogin">เข้าสู่ระบบ</button>';
  $('btnLogin')?.addEventListener('click', () => $('loginDlg').showModal());
  $('btnLogout')?.addEventListener('click', async () => { await core.signOut(); refresh(); });
  ['btnLayer', 'btnEvents', 'btnStations'].forEach((b) => ($(b).disabled = !can));
  if (!p) return;
  try {
    const src = await core.listSources();
    const opts = src.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} — ${esc(s.name_th)}</option>`).join('');
    ['layerSource', 'evSource', 'stSource'].forEach((id) => ($(id).innerHTML = '<option value="">—</option>' + opts));
    $('evSource').value = 'dmr_landslide'; $('stSource').value = 'dede_solar'; $('layerSource').value = 'rfd_reserve_forest';
  } catch (e) { log('อ่าน sources ไม่ได้: ' + e.message); }
  if (p.role === 'admin') {
    try {
      const runs = await core.listIngestRuns(30);
      $('runs').querySelector('tbody').innerHTML = runs.map((r) => `<tr><td>${esc(r.source_id)}</td><td>${esc(core.fmtThaiDateTime(r.started_at))}</td><td>${r.ok ? '✅' : '❌'}</td><td>${r.rows_upserted}</td><td>${esc(r.error ?? (r.cursor ? JSON.stringify(r.cursor) : ''))}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">ยังไม่มีรอบดึงข้อมูล — กด Invoke ที่ Edge Function envi-ingest</td></tr>';
    } catch { /* viewer/editor อ่านไม่ได้ ตามนโยบาย */ }
  }
}

if (typeof document !== 'undefined' && $('btnLayer')) {
  $('btnLayer').addEventListener('click', () => importLayer().catch((e) => log('ล้ม: ' + e.message)));
  $('btnEvents').addEventListener('click', () => importEvents().catch((e) => log('ล้ม: ' + e.message)));
  $('btnStations').addEventListener('click', () => importStations().catch((e) => log('ล้ม: ' + e.message)));
  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await core.signIn($('loginEmail').value.trim(), $('loginPass').value);
    if (!r.ok) { $('loginErr').textContent = r.error; return; }
    $('loginDlg').close(); refresh();
  });
  core.onAuthChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT' || ev === 'INITIAL_SESSION') refresh(); });
}
