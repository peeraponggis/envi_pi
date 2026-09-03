/**
 * envi-core.js — แกนกลางของ envi_pi **ห้ามแตะ DOM ในไฟล์นี้** (ทดสอบด้วย node --test)
 *
 * สิ่งที่อยู่ในนี้
 *   1. ไคลเอนต์ Supabase ตัวเดียว (cache Promise) — คัดแบบจาก pi_crm_erp/web/js/pi-core.js
 *   2. เข้าสู่ระบบ / โปรไฟล์
 *   3. ตัวอ่านข้อมูล: สถานี+ค่าล่าสุด · เหตุการณ์ · site_report · ชั้นโพลิกอน · บันทึกผล
 *   4. API ต่างประเทศเรียกสด (NASA POWER / PVGIS / Nominatim) + แคชลง api_cache
 *   5. ฟังก์ชันบริสุทธิ์: num() · parseThaiDate() · aqiLevel() · moduleTemp() · interpret*()
 *
 * ทุกอย่างที่คุย DOM อยู่ใน app.js เท่านั้น
 */
import {
  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, AUTH_STORAGE_KEY, CACHE_TTL_DAYS, AQI_LEVELS, PM25_LEVELS,
} from './config.js';

const CDN = 'https://esm.sh/@supabase/supabase-js@2';

export const isConfigured = () =>
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME');

// ════════════════════════════════════════════════════════════ ไคลเอนต์

function offlineClient(reason = 'ออฟไลน์ — ต่อเน็ตแล้วลองใหม่') {
  const off = { data: null, error: { message: reason, offline: true } };
  // ต้องต่อโซ่ได้ทุกแบบ (.from().select().like().order()…) และ await ได้ทุกจุด
  // — ต่างจาก pi-core ที่ await ทันทีหลัง select
  const chain = () => new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? (resolve) => resolve(off) : chain()),
    apply: () => chain(),
  });
  return {
    __offline: true,
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      signInWithPassword: async () => off,
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async () => off,
    from: () => chain(),
  };
}

let _clientPromise = null;

/**
 * ⚠️ ต้องมีไคลเอนต์เดียวทั้งหน้า และต้องเก็บ Promise ไม่ใช่ตัวไคลเอนต์
 * (เหตุผลเต็มอยู่ใน pi_crm_erp/web/js/pi-core.js บรรทัด 183-196)
 */
export function getClient() {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    if (!isConfigured()) return offlineClient('ยังไม่ได้ตั้งค่า web/js/config.js (SUPABASE_URL / key)');
    try {
      const { createClient } = await import(/* @vite-ignore */ CDN);
      return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
      });
    } catch (e) {
      console.warn('โหลด supabase-js ไม่ได้ ใช้โหมดออฟไลน์', e);
      return offlineClient();
    }
  })();
  return _clientPromise;
}

/** ใช้ในชุดทดสอบเท่านั้น */
export function __setClient(fake) { _clientPromise = Promise.resolve(fake); }

// ════════════════════════════════════════════════════════════ เข้าสู่ระบบ

export function translateAuthError(error) {
  const m = String(error?.message ?? '').toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid_credentials')) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  if (m.includes('email not confirmed')) return 'อีเมลนี้ยังไม่ได้ยืนยัน — ให้ผู้ดูแลระบบติ๊ก Auto Confirm ให้';
  if (m.includes('rate limit') || m.includes('too many')) return 'ลองเข้าสู่ระบบถี่เกินไป รอสักครู่แล้วลองใหม่';
  if (error?.offline) return error.message;
  return error?.message ?? 'เข้าสู่ระบบไม่สำเร็จ';
}

export async function signIn(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: translateAuthError(error) };
  return { ok: true, session: data.session, user: data.user };
}

export async function signOut() { const sb = await getClient(); await sb.auth.signOut(); }

export async function currentSession() {
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  return data?.session ?? null;
}

/** ⚠️ ต้องดู event ด้วย ห้ามดูแค่ session ว่าง (INITIAL_SESSION มาพร้อม null เสมอ) */
export function onAuthChange(fn) {
  let unsub = () => {};
  getClient().then((sb) => {
    const { data } = sb.auth.onAuthStateChange((event, s) => fn(event, s));
    unsub = () => data?.subscription?.unsubscribe?.();
  });
  return () => unsub();
}

export async function myProfile() {
  const sb = await getClient();
  const { data: u } = await sb.auth.getUser();
  if (!u?.user) return null;
  const { data } = await sb.from('profiles').select('id, email, full_name, role').eq('id', u.user.id).maybeSingle();
  return data ?? { id: u.user.id, email: u.user.email, role: 'viewer' };
}

export const canImport = (role) => role === 'admin' || role === 'editor';

// ════════════════════════════════════════════════════════════ อ่านข้อมูล

function unwrap({ data, error }) {
  if (error) throw new Error(error.message ?? String(error));
  return data;
}

/** สถานี + ค่าล่าสุดของแหล่งที่ขึ้นต้นด้วย prefix (เช่น 'air4thai', 'tmd_') */
export async function fetchStationsLatest(sourcePrefix) {
  const sb = await getClient();
  return unwrap(await sb.from('v_station_latest').select('*').like('source_id', `${sourcePrefix}%`).limit(5000)) ?? [];
}

/**
 * เหตุการณ์ y วันล่าสุดตามชนิด
 * ⚠️ ชั้นประวัติ (ดินถล่ม DMR 56,177 จุด ไม่มีปี) ต้องอ่านจากตาราง events ตรง ๆ
 *    เพราะวิว v_recent_events กรอง 30 วัน — ส่ง days > 3650 เพื่อบอกว่าเป็นชั้นประวัติ
 */
export async function fetchRecentEvents(kind, days = 7, limit = 5000) {
  const sb = await getClient();
  if (days > 3650) {
    return unwrap(await sb.from('events').select('id, source_id, kind, occurred_at, lat, lng, magnitude, title, province, props, imported_manually')
      .eq('kind', kind).limit(limit)) ?? [];
  }
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  return unwrap(await sb.from('v_recent_events').select('*').eq('kind', kind).gte('occurred_at', since)
    .order('occurred_at', { ascending: false }).limit(limit)) ?? [];
}

export async function listSources() {
  const sb = await getClient();
  return unwrap(await sb.from('sources').select('*').order('category').order('id')) ?? [];
}

export async function listLayers() {
  const sb = await getClient();
  return unwrap(await sb.from('layers').select('*').order('id')) ?? [];
}

export async function siteReport(lat, lng) {
  const sb = await getClient();
  return unwrap(await sb.rpc('site_report', { p_lat: lat, p_lng: lng }));
}

export async function nearestStations(lat, lng, radiusM = 50000, source = null, limit = 10) {
  const sb = await getClient();
  return unwrap(await sb.rpc('nearest_stations', { p_lat: lat, p_lng: lng, p_radius_m: radiusM, p_source: source, p_limit: limit })) ?? [];
}

/** meta ของสถานีหนึ่งแถว — nearest_stations() ไม่คืน meta (เจอ 3 ก.ย. 69 ตอนต่อแผนที่รังสี พพ.) */
export async function fetchStationMeta(stationId) {
  const sb = await getClient();
  const row = unwrap(await sb.from('stations').select('meta').eq('id', stationId).maybeSingle());
  return row?.meta ?? {};
}

export async function layerFeaturesBbox(layerId, bbox, tolerance = 0) {
  const sb = await getClient();
  const [minx, miny, maxx, maxy] = bbox;
  return unwrap(await sb.rpc('layer_features_bbox', {
    p_layer: layerId, p_minx: minx, p_miny: miny, p_maxx: maxx, p_maxy: maxy, p_tolerance: tolerance,
  }));
}

export async function saveAssessment(name, lat, lng, report, refNote = null) {
  const sb = await getClient();
  return unwrap(await sb.rpc('save_assessment', { p_name: name, p_lat: lat, p_lng: lng, p_report: report, p_ref_note: refNote }));
}

export async function listAssessments() {
  const sb = await getClient();
  return unwrap(await sb.from('site_assessments').select('id, name, lat, lng, ref_note, created_at')
    .order('created_at', { ascending: false }).limit(200)) ?? [];
}

export async function listIngestRuns(limit = 30) {
  const sb = await getClient();
  return unwrap(await sb.from('ingest_runs').select('*').order('started_at', { ascending: false }).limit(limit)) ?? [];
}

// ════════════════════════════════════════════════════════════ แคช + API ต่างประเทศ

/** key แคชปัดพิกัด 2 ตำแหน่ง (~1 กม.) — ตรงกับที่ site_report() ใช้หา solar_cache */
export function cacheKey(prefix, lat, lng) {
  return `${prefix}:${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
}

/**
 * อ่านแคชก่อน ไม่มี/หมดอายุจึงเรียก fn แล้วพยายามเขียนแคช
 * เขียนไม่ได้ (anon ไม่มีสิทธิ์) ก็ไม่เป็นไร — คืนค่าสดให้ผู้ใช้ไปก่อน
 */
export async function withCache(key, fn, { ttlDays = CACHE_TTL_DAYS, sourceId = null } = {}) {
  const sb = await getClient();
  try {
    const { data } = await sb.from('api_cache').select('payload, fetched_at').eq('cache_key', key).maybeSingle();
    if (data && Date.now() - new Date(data.fetched_at).getTime() < ttlDays * 86400e3) {
      return { payload: data.payload, cached: true, fetched_at: data.fetched_at };
    }
  } catch { /* อ่านแคชไม่ได้ก็ไปเรียกสด */ }
  const payload = await fn();
  try {
    await sb.from('api_cache').upsert({ cache_key: key, source_id: sourceId, payload, fetched_at: new Date().toISOString() });
  } catch { /* anon เขียนไม่ได้ — ตั้งใจ */ }
  return { payload, cached: false, fetched_at: new Date().toISOString() };
}

/** NASA POWER รายวันปีล่าสุดที่ครบ → สรุปเป็นค่าเดียวกับที่ไฟล์ V2.9.0 ใช้ */
export async function fetchNasaPower(lat, lng, year = new Date().getFullYear() - 1) {
  const params = 'ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DIFF,T2M,WS2M,RH2M';
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=${params}&community=RE` +
    `&longitude=${lng}&latitude=${lat}&start=${year}0101&end=${year}1231&format=JSON`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`NASA POWER HTTP ${r.status}`);
  return summarizeNasaPower(await r.json(), year);
}

/** ฟังก์ชันบริสุทธิ์ — แปลง JSON ของ NASA POWER เป็น {ghi, diffuse, airTemp, windSpeed, humidity} */
export function summarizeNasaPower(json, year = null) {
  const p = json?.properties?.parameter ?? {};
  const sum = (o) => Object.values(o ?? {}).filter((v) => typeof v === 'number' && v > -900).reduce((a, b) => a + b, 0);
  const avg = (o) => { const v = Object.values(o ?? {}).filter((x) => typeof x === 'number' && x > -900); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    source: 'NASA POWER', year,
    ghi: Math.round(sum(p.ALLSKY_SFC_SW_DWN)),          // kWh/m²/ปี (ค่ารายวันเป็น kWh/m²/วัน)
    diffuse: Math.round(sum(p.ALLSKY_SFC_SW_DIFF)),
    airTemp: r2(avg(p.T2M)), windSpeed: r2(avg(p.WS2M)), humidity: r2(avg(p.RH2M)),
    days: Object.keys(p.ALLSKY_SFC_SW_DWN ?? {}).length,
  };
}

/** PVGIS รายชั่วโมง 1 ปี → ค่าที่ชั่วโมงที่ผู้ใช้เลือก (instantGhi, อุณหภูมิ, ลม) */
export async function fetchPvgisHour(lat, lng, month, hour, year = 2020) {
  const url = `https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat=${lat}&lon=${lng}&startyear=${year}&endyear=${year}` +
    `&pvcalculation=0&components=1&outputformat=json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`PVGIS HTTP ${r.status}`);
  return summarizePvgis(await r.json(), month, hour);
}

export function summarizePvgis(json, month, hour) {
  const rows = json?.outputs?.hourly ?? [];
  const mm = String(month).padStart(2, '0'), hh = String(hour).padStart(2, '0');
  const pick = rows.filter((x) => String(x.time ?? '').slice(4, 6) === mm && String(x.time ?? '').slice(9, 11) === hh);
  const avg = (k) => (pick.length ? pick.reduce((a, x) => a + (Number(x[k]) || 0), 0) / pick.length : null);
  const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
  const gi = (avg('G(i)') ?? 0) + 0, gb = avg('Gb(i)') ?? 0, gd = avg('Gd(i)') ?? 0;
  return { source: 'PVGIS', instantGhi: Math.round(gi || gb + gd), airTemp: r1(avg('T2m')), windSpeed: r1(avg('WS10m')), samples: pick.length };
}

/**
 * พยากรณ์อากาศ ณ จุด — ผ่าน Edge Function `envi-ingest` action "forecast"
 * (token ของ TMD อยู่ฝั่งเซิร์ฟเวอร์ · แคช 1 ชม. ต่อพิกัด ~1 กม.) คืน {hourly:[{time,tc,rh,rain,ws10m,wd10m,cond,cond_th}], daily:[…], grid, cached}
 */
export async function fetchForecast(lat, lng) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/envi-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ action: 'forecast', lat, lng }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** รอยไหม้จากภาพดาวเทียม GISTDA รอบจุด (±5 กม.) — ผ่าน Edge action "burnscar" (key ฝั่งเซิร์ฟเวอร์ แคช 24 ชม.) */
export async function fetchBurnScar(lat, lng) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/envi-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ action: 'burnscar', lat, lng }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** "20260511 - 20260520" → "11–20 พ.ค. 2569" */
export function fmtBurnPeriod(s) {
  const m = String(s ?? '').match(/(\d{4})(\d{2})(\d{2})\s*-\s*(\d{4})(\d{2})(\d{2})/);
  if (!m) return s ?? '—';
  const th = (y, mo, d) => new Date(Date.UTC(+y, +mo - 1, +d)).toLocaleDateString('th-TH', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return `${+m[3]}–${th(m[4], m[5], m[6])}`;
}

/** ทิศลม 16 ทิศจากองศา */
export function windDir(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return '—';
  const d = ['น', 'น-ตอ', 'ตอ', 'ตอ-ต', 'ต', 'ต-ตต', 'ตต', 'ตต-น'];
  return d[Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8];
}

/** สรุปพยากรณ์รายชั่วโมงเป็นประโยค: ฝนสะสม 24 ชม., ชั่วโมงที่ฝนตก, ช่วงอุณหภูมิ */
export function summarizeForecast(fc) {
  const h = fc?.hourly ?? [];
  if (!h.length) return null;
  const rain = h.reduce((a, x) => a + (Number(x.rain) || 0), 0);
  const rainy = h.filter((x) => (Number(x.rain) || 0) >= 0.5 || Number(x.cond) >= 5 && Number(x.cond) <= 8);
  const tcs = h.map((x) => Number(x.tc)).filter(Number.isFinite);
  return {
    rain_mm: Math.round(rain * 10) / 10, rainy_hours: rainy.length,
    tc_min: tcs.length ? Math.min(...tcs) : null, tc_max: tcs.length ? Math.max(...tcs) : null,
    first_rain: rainy[0]?.time ?? null,
  };
}

export async function reverseGeocode(lat, lng) {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=th`);
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  const j = await r.json();
  return formatThaiAddress(j?.address);
}

export function formatThaiAddress(addr) {
  if (!addr) return null;
  // Nominatim ส่งชื่อมาพร้อมคำนำหน้าเต็ม ("อำเภอเมืองปทุมธานี", "จังหวัดปทุมธานี") — ตัดออกก่อนเติม ต./อ./จ.
  const strip = (s) => String(s ?? '').replace(/^(ตำบล|แขวง|อำเภอ|เขต|จังหวัด)\s*/, '').trim();
  const sub = strip(addr.subdistrict || addr.village || addr.suburb || addr.quarter);
  const dist = strip(addr.district || addr.city_district || addr.town || addr.county);
  const prov = strip(addr.province || addr.state || addr.city);
  if (prov === 'กรุงเทพมหานคร') return [sub && `แขวง${sub}`, dist && `เขต${dist}`, prov].filter(Boolean).join(' ');
  return [sub && `ต.${sub}`, dist && `อ.${dist}`, prov && `จ.${prov}`].filter(Boolean).join(' ') || null;
}

// ════════════════════════════════════════════════════════════ ฟังก์ชันบริสุทธิ์

/** ค่าที่หน่วยงานส่งมา → number หรือ null (sentinel ทุกแบบ = null) — ใช้คู่กับ Edge Function */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') v = v.value ?? v.aqi ?? null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === 'N/A' || s === 'null') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n === -1 || n === -999 || n === -9999 || n <= -99) return null;
  return n;
}

export const ceYear = (y) => (y > 2400 ? y - 543 : y);

/** "3/9/2569" · "2569-09-03" · "03-09-2569 10:00" (เวลาไทย) → Date (UTC จริง) หรือ null */
export function parseThaiDate(s, time = '00:00') {
  if (!s) return null;
  s = String(s).trim();
  let y, m, d, hh = 0, mi = 0;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; hh = +(mt[4] ?? 0); mi = +(mt[5] ?? 0); }
  else {
    mt = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!mt) return null;
    d = +mt[1]; m = +mt[2]; y = +mt[3]; hh = +(mt[4] ?? 0); mi = +(mt[5] ?? 0);
  }
  if (!mt[4] && time) { const [th, tm] = String(time).split(':'); hh = +th || 0; mi = +tm || 0; }
  const dt = new Date(Date.UTC(ceYear(y), m - 1, d, hh - 7, mi));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** วันนี้ตามเวลาไทย (YYYY-MM-DD) — ห้ามใช้ toISOString().slice(0,10) เพราะกลายเป็น UTC */
export function todayISO(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600e3);
  return t.toISOString().slice(0, 10);
}

export function fmtThaiDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
}

/** เวลาผ่านไปแบบอ่านง่าย */
export function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'เมื่อสักครู่';
  if (s < 5400) return `${Math.round(s / 60)} นาทีที่แล้ว`;
  if (s < 129600) return `${Math.round(s / 3600)} ชั่วโมงที่แล้ว`;
  return `${Math.round(s / 86400)} วันที่แล้ว`;
}

function level(table, v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return { label: 'ไม่มีข้อมูล', color: '#9e9e9e', index: -1 };
  const i = table.findIndex((l) => Number(v) <= l.max);
  return { ...table[i], index: i };
}
export const aqiLevel = (v) => level(AQI_LEVELS, v);
export const pm25Level = (v) => level(PM25_LEVELS, v);

/** สีจุดสถานี — ใช้ AQI ก่อน ไม่มีค่อยดู PM2.5 */
export function stationColor(latest) {
  const aqi = latest?.AQI?.value;
  if (aqi !== null && aqi !== undefined) return aqiLevel(aqi).color;
  const pm = latest?.PM25?.value;
  if (pm !== null && pm !== undefined) return pm25Level(pm).color;
  return '#9e9e9e';
}

/** อุณหภูมิแผง King/Sandia — ย้ายจากไฟล์ V2.9.0 ตรงตัว (coeff สำหรับ glass/cell/polymer open rack) */
export function moduleTemp({ instantGhi, windSpeed, airTemp }, { a = -3.47, b = -0.0594, deltaT = 3 } = {}) {
  const e = Number(instantGhi) || 0, ws = Number(windSpeed) || 0, ta = Number(airTemp) || 0;
  const back = e * Math.exp(a + b * ws) + ta;
  return back + (e / 1000) * deltaT;
}

export function interpretGHI(ghi) {
  if (ghi >= 1850) return { status: 'ดีเยี่ยม (Excellent Area)', style: 'good' };
  if (ghi >= 1600) return { status: 'ดี', style: 'good' };
  return { status: 'ปานกลาง', style: 'warning' };
}
export function interpretDiffuse(diffuse, ghi) {
  if (!ghi) return { status: 'ไม่มีข้อมูล', style: 'warning' };
  if (diffuse / ghi <= 0.45) return { status: 'ดีเยี่ยม (สัดส่วนรังสีตรงชัดเจน)', style: 'good' };
  return { status: 'ปกติ', style: 'warning' };
}
export function interpretModuleTemp(t) {
  if (t <= 45) return { status: 'ดีเยี่ยม (ประสิทธิภาพเต็ม)', style: 'good' };
  if (t <= 54) return { status: 'ปกติ (สูญเสียต่ำ)', style: 'warning' };
  return { status: 'พึงระวัง (High Thermal Derating)', style: 'danger' };
}

/** แปลง lat,lng ที่ผู้ใช้พิมพ์ (รองรับช่องว่าง/ลำดับกลับ) */
export function parseCoords(text) {
  const m = String(text ?? '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  let lat = +m[1], lng = +m[2];
  if (lat > 90 && lng <= 90) [lat, lng] = [lng, lat];          // พิมพ์สลับ
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** สรุปหมวดของ site_report เป็นประโยคเดียว (ใช้ในการ์ดสรุป) */
export function summarizeReport(rep) {
  if (!rep) return [];
  const out = [];
  const aqi = rep.air?.latest?.AQI?.value;
  if (rep.air) out.push({ key: 'air', text: aqi != null ? `AQI ${aqi} (${aqiLevel(aqi).label}) ที่ ${rep.air.name_th ?? ''} ห่าง ${Math.round((rep.air.distance_m ?? 0) / 1000)} กม.` : `สถานีใกล้สุด ${rep.air.name_th ?? ''} ยังไม่มีค่า`, level: aqiLevel(aqi).style ?? '' });
  else out.push({ key: 'air', text: 'ไม่มีสถานีตรวจวัดอากาศใน 50 กม.' });
  const h = rep.hotspots_7d_10km?.count ?? 0;
  out.push({ key: 'hotspot', text: h ? `จุดความร้อน ${h} จุดใน 10 กม. (7 วัน)` : 'ไม่พบจุดความร้อนใน 10 กม. (7 วัน)' });
  const q = rep.quakes_30d_300km?.count ?? 0;
  out.push({ key: 'quake', text: q ? `แผ่นดินไหว ${q} ครั้งใน 300 กม. (30 วัน)` : 'ไม่มีแผ่นดินไหวใน 300 กม. (30 วัน)' });
  const ls = rep.landslides_10km?.count ?? 0;
  if (ls) out.push({ key: 'landslide', text: `ประวัติดินถล่ม ${ls} จุดใน 10 กม.` });
  const w = rep.wells_5km?.count ?? 0;
  if (w) out.push({ key: 'wells', text: `บ่อบาดาล ${w} บ่อใน 5 กม.` });
  // ขอบเขตจังหวัด/อำเภอ (dwr_province, dwr_amphoe) ไปอยู่ในหัวรายงานแล้ว ไม่ต้องซ้ำในบรรทัดนี้
  const hits = (rep.layer_hits ?? []).filter((x) => !/^dwr_(province|amphoe|tambon)$/.test(x.layer_id ?? ''));
  if (hits.length) out.push({ key: 'layers', text: 'อยู่ในเขต: ' + hits.map((x) => `${x.layer}${x.feature ? ' — ' + x.feature : ''}`).join(' · ') });
  return out;
}
