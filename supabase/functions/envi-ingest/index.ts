// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  envi-ingest — Edge Function ดึงข้อมูลจากหน่วยราชการไทยเข้า Supabase         ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// วิธี deploy (ไม่มี CLI): Dashboard → Edge Functions → Create function ชื่อ `envi-ingest`
//   → วางไฟล์นี้ทั้งไฟล์ → Deploy → ตั้งค่า "Verify JWT" = **ปิด** (เราตรวจ token เอง)
//   → Secrets: ENVI_CRON_TOKEN (ตัวเดียวกับใน Vault) · TMD_UID · TMD_UKEY · GISTDA_API_KEY · FIRMS_MAP_KEY
//   ⚠️ ไฟล์นี้คือสำเนาหลัก — แก้ที่นี่แล้วค่อยวางทับใน Dashboard ห้ามแก้ใน Dashboard อย่างเดียว
//
// เรียก: POST {"source":"air4thai"}  header Authorization: Bearer <ENVI_CRON_TOKEN>
//   หรือ {"source":"air4thai","dry":true} เพื่อดูว่า parse ได้กี่แถวโดยไม่เขียน
//
// หลักที่ยึด
//   1. fail-soft: handler ล้มก็บันทึก ingest_runs.ok=false พร้อม error แล้วตอบ 200 — ไม่ให้ cron ค้าง
//   2. ค่าเป็น string / -1 / -999 / "" / "-" → null + quality 'missing' (ห้ามเก็บ -999 ลง value)
//   3. เวลาที่หน่วยงานให้มาเป็นเวลาไทยไม่มี TZ → ต่อ +07:00 ก่อน parse
//   4. ArcGIS คืนสูงสุด 1000 แถว → วน resultOffset จน exceededTransferLimit เป็น false
//   5. รายงานเป็นตัวเลข: กี่แถวเข้า กี่แถวข้าม ไม่ใช่ ok/ไม่ ok
//
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const VERSION = "1.0.0";

type Json = Record<string, unknown>;
type HandlerResult = { rows: number; cursor?: Json; note?: string };
type Ctx = { sb: SupabaseClient; source: Json; dry: boolean; cursor: Json | null };

// ─────────────────────────────────────────────────────────── ตัวช่วยทั่วไป

/** แปลงค่าที่หน่วยงานส่งมา (string/number) เป็น number หรือ null — sentinel ทุกแบบ = null */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") v = (v as Json).value ?? (v as Json).aqi ?? null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "-" || s === "N/A" || s === "null") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n === -1 || n === -999 || n === -9999 || n <= -99) return null;
  return n;
}

/** พ.ศ. → ค.ศ. (ปี > 2400 ถือว่าเป็น พ.ศ.) */
export function ceYear(y: number): number {
  return y > 2400 ? y - 543 : y;
}

/** "2569-09-03" + "10:00" (เวลาไทย) → ISO UTC · รองรับ พ.ศ. และ dd/mm/yyyy */
export function thaiDateTimeToISO(date: string, time = "00:00"): string | null {
  if (!date) return null;
  let y: number, m: number, d: number;
  const iso = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const dmy = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3]; }
  else return null;
  y = ceYear(y);
  const [hh = "0", mm = "0"] = String(time).split(":");
  const dt = new Date(Date.UTC(y, m - 1, d, +hh - 7, +mm)); // ไทย = UTC+7
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** ArcGIS ส่งเวลาเป็น epoch ms หรือ string */
function arcgisTime(v: unknown, timeStr?: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    const dt = new Date(v);
    if (timeStr && /^\d{3,4}$/.test(String(timeStr))) {
      // ACQ_DATE (เที่ยงคืน UTC) + ACQ_TIME "HHMM"
      const t = String(timeStr).padStart(4, "0");
      dt.setUTCHours(+t.slice(0, 2), +t.slice(2));
    }
    return dt.toISOString();
  }
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? thaiDateTimeToISO(s, timeStr ? String(timeStr) : undefined) : d.toISOString();
}

function pick(o: Json, keys: string[]): unknown {
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(o)) lower[k.toLowerCase()] = o[k];
  for (const k of keys) { const v = lower[k.toLowerCase()]; if (v !== undefined && v !== null && v !== "") return v; }
  return undefined;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(url, { ...init, headers: { "User-Agent": "envi-pi/" + VERSION, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`ไม่ใช่ JSON (${text.slice(0, 80)}) ${url}`); }
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": "envi-pi/" + VERSION } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

function chunk<T>(a: T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

async function upsert(ctx: Ctx, table: string, rows: Json[], onConflict: string): Promise<number> {
  if (ctx.dry || rows.length === 0) return rows.length;
  let n = 0;
  for (const part of chunk(rows)) {
    const { error } = await ctx.sb.from(table).upsert(part, { onConflict, ignoreDuplicates: false });
    if (error) throw new Error(`${table}: ${error.message}`);
    n += part.length;
  }
  return n;
}

/** upsert สถานีแล้วคืน map ext_id → id */
async function upsertStations(ctx: Ctx, sourceId: string, rows: Json[]): Promise<Map<string, number>> {
  await upsert(ctx, "stations", rows.map((r) => ({ ...r, source_id: sourceId })), "source_id,ext_id");
  const map = new Map<string, number>();
  if (ctx.dry) return map;
  const { data, error } = await ctx.sb.from("stations").select("id, ext_id").eq("source_id", sourceId);
  if (error) throw new Error("อ่าน stations: " + error.message);
  for (const s of data ?? []) map.set(String(s.ext_id), Number(s.id));
  return map;
}

// ─────────────────────────────────────────────────────────── ค่าคงที่ภูมิศาสตร์

/** จุดศูนย์กลางโดยประมาณ 77 จังหวัด (ระดับจังหวัดพอ ไม่ใช่แนวเขต) */
const PROVINCE_CENTROID: Record<string, [number, number]> = {
  "กรุงเทพมหานคร": [13.7563, 100.5018], "กระบี่": [8.0863, 98.9063], "กาญจนบุรี": [14.0228, 99.5328],
  "กาฬสินธุ์": [16.4322, 103.5061], "กำแพงเพชร": [16.4828, 99.5227], "ขอนแก่น": [16.4322, 102.8236],
  "จันทบุรี": [12.6100, 102.1035], "ฉะเชิงเทรา": [13.6904, 101.0780], "ชลบุรี": [13.3611, 100.9847],
  "ชัยนาท": [15.1852, 100.1251], "ชัยภูมิ": [15.8068, 102.0315], "ชุมพร": [10.4930, 99.1800],
  "เชียงราย": [19.9105, 99.8406], "เชียงใหม่": [18.7883, 98.9853], "ตรัง": [7.5593, 99.6110],
  "ตราด": [12.2428, 102.5175], "ตาก": [16.8840, 99.1259], "นครนายก": [14.2069, 101.2131],
  "นครปฐม": [13.8199, 100.0620], "นครพนม": [17.4108, 104.7784], "นครราชสีมา": [14.9799, 102.0978],
  "นครศรีธรรมราช": [8.4304, 99.9631], "นครสวรรค์": [15.7030, 100.1371], "นนทบุรี": [13.8591, 100.5217],
  "นราธิวาส": [6.4255, 101.8253], "น่าน": [18.7756, 100.7730], "บึงกาฬ": [18.3609, 103.6466],
  "บุรีรัมย์": [14.9930, 103.1029], "ปทุมธานี": [14.0208, 100.5250], "ประจวบคีรีขันธ์": [11.8126, 99.7957],
  "ปราจีนบุรี": [14.0509, 101.3660], "ปัตตานี": [6.8692, 101.2502], "พระนครศรีอยุธยา": [14.3532, 100.5689],
  "พะเยา": [19.1664, 99.9019], "พังงา": [8.4510, 98.5309], "พัทลุง": [7.6167, 100.0740],
  "พิจิตร": [16.4430, 100.3489], "พิษณุโลก": [16.8211, 100.2659], "เพชรบุรี": [13.1119, 99.9399],
  "เพชรบูรณ์": [16.4190, 101.1591], "แพร่": [18.1445, 100.1403], "ภูเก็ต": [7.8804, 98.3923],
  "มหาสารคาม": [16.1851, 103.3029], "มุกดาหาร": [16.5426, 104.7208], "แม่ฮ่องสอน": [19.3020, 97.9654],
  "ยโสธร": [15.7925, 104.1451], "ยะลา": [6.5411, 101.2804], "ร้อยเอ็ด": [16.0538, 103.6520],
  "ระนอง": [9.9658, 98.6348], "ระยอง": [12.6814, 101.2816], "ราชบุรี": [13.5283, 99.8134],
  "ลพบุรี": [14.7995, 100.6534], "ลำปาง": [18.2888, 99.4908], "ลำพูน": [18.5744, 99.0087],
  "เลย": [17.4860, 101.7223], "ศรีสะเกษ": [15.1186, 104.3220], "สกลนคร": [17.1546, 104.1348],
  "สงขลา": [7.1756, 100.6144], "สตูล": [6.6238, 100.0674], "สมุทรปราการ": [13.5991, 100.5998],
  "สมุทรสงคราม": [13.4098, 100.0022], "สมุทรสาคร": [13.5475, 100.2740], "สระแก้ว": [13.8240, 102.0645],
  "สระบุรี": [14.5289, 100.9101], "สิงห์บุรี": [14.8879, 100.4010], "สุโขทัย": [17.0056, 99.8263],
  "สุพรรณบุรี": [14.4745, 100.1177], "สุราษฎร์ธานี": [9.1382, 99.3215], "สุรินทร์": [14.8818, 103.4936],
  "หนองคาย": [17.8783, 102.7413], "หนองบัวลำภู": [17.2218, 102.4260], "อ่างทอง": [14.5896, 100.4550],
  "อำนาจเจริญ": [15.8657, 104.6258], "อุดรธานี": [17.4138, 102.7872], "อุตรดิตถ์": [17.6200, 100.0993],
  "อุทัยธานี": [15.3835, 100.0246], "อุบลราชธานี": [15.2287, 104.8564],
};

/** สถานีเรดาร์ฝนหลวง (พิกัดโดยประมาณจากที่ตั้งสถานี) */
const RADAR_STATIONS: Record<string, { name: string; lat: number; lng: number }> = {
  omkoi:     { name: "อมก๋อย (เชียงใหม่)",        lat: 17.7980, lng: 98.4320 },
  rongkwang: { name: "ร้องกวาง (แพร่)",           lat: 18.3400, lng: 100.3200 },
  takhli:    { name: "ตาคลี (นครสวรรค์)",         lat: 15.2600, lng: 100.3500 },
  rasisalai: { name: "ราษีไศล (ศรีสะเกษ)",       lat: 15.3400, lng: 104.1600 },
  singha:    { name: "สิงห์บุรี",                 lat: 14.8900, lng: 100.4000 },
  phimai:    { name: "พิมาย (นครราชสีมา)",        lat: 15.2200, lng: 102.4900 },
  banphue:   { name: "บ้านผือ (อุดรธานี)",        lat: 17.6900, lng: 102.4700 },
  sattahip:  { name: "สัตหีบ (ชลบุรี)",           lat: 12.6800, lng: 100.9800 },
  pathio:    { name: "ปะทิว (ชุมพร)",             lat: 10.7100, lng: 99.3600 },
  phanom:    { name: "พนม (สุราษฎร์ธานี)",        lat: 8.8600, lng: 98.8200 },
  inburi:    { name: "อินทร์บุรี (สิงห์บุรี)",     lat: 15.0100, lng: 100.3300 },
};

// ─────────────────────────────────────────────────────────── handlers

/** Air4Thai — ทุกสถานี ค่าล่าสุด */
async function air4thai(ctx: Ctx): Promise<HandlerResult> {
  const url = String(ctx.source.url);
  const data = await fetchJson(url) as { stations?: Json[] };
  const list = data.stations ?? [];
  if (list.length === 0) throw new Error("Air4Thai คืน stations ว่าง");

  const stRows: Json[] = [];
  for (const s of list) {
    const lat = num(s.lat), lng = num(s.long ?? s.lng);
    if (lat === null || lng === null) continue;
    stRows.push({
      ext_id: String(s.stationID), name_th: s.nameTH, name_en: s.nameEN, area_th: s.areaTH,
      province: String(s.areaTH ?? "").split(",").pop()?.replace(/^\s*จ\.?\s*/, "").trim() || null,
      station_type: s.stationType, lat, lng, meta: { station_type: s.stationType },
    });
  }
  const ids = await upsertStations(ctx, "air4thai", stRows);

  const PARAMS = ["PM25", "PM10", "O3", "CO", "NO2", "SO2"];
  const UNITS: Record<string, string> = { PM25: "µg/m³", PM10: "µg/m³", O3: "ppb", CO: "ppm", NO2: "ppb", SO2: "ppb", AQI: "" };
  const obs: Json[] = [], latest: Json[] = [];
  for (const s of list) {
    const id = ids.get(String(s.stationID));
    const last = (s.AQILast ?? {}) as Json;
    const at = thaiDateTimeToISO(String(last.date ?? ""), String(last.time ?? "00:00"));
    if (!id || !at) continue;
    for (const p of PARAMS) {
      const raw = last[p] as Json | undefined;
      const v = num(raw);
      obs.push({ station_id: id, observed_at: at, parameter: p, value: v, unit: UNITS[p], quality: v === null ? "missing" : "ok" });
      latest.push({ station_id: id, parameter: p, observed_at: at, value: v, unit: UNITS[p],
        extra: { aqi: num(raw?.aqi), color_id: raw?.color_id ?? null } });
    }
    const aqi = last.AQI as Json | undefined;
    const av = num(aqi?.aqi ?? aqi);
    obs.push({ station_id: id, observed_at: at, parameter: "AQI", value: av, unit: "", quality: av === null ? "missing" : "ok" });
    latest.push({ station_id: id, parameter: "AQI", observed_at: at, value: av, unit: "",
      extra: { color_id: aqi?.color_id ?? null, param: aqi?.param ?? null } });
  }
  const n1 = await upsert(ctx, "observations", obs, "station_id,parameter,observed_at");
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  return { rows: n1, note: `สถานี ${stRows.length} · ค่า ${n1}` };
}

/** GISTDA เช็คฝุ่น รายจังหวัด → stations ต่อจังหวัด (พิกัดจากตาราง centroid) */
async function gistda_pm25(ctx: Ctx): Promise<HandlerResult> {
  const raw = await fetchJson(String(ctx.source.url));
  const arr: Json[] = Array.isArray(raw) ? raw
    : Array.isArray((raw as Json).data) ? (raw as Json).data as Json[]
    : Array.isArray((raw as Json).result) ? (raw as Json).result as Json[]
    : Array.isArray((raw as Json).features) ? ((raw as Json).features as Json[]).map((f) => ({ ...(f.properties as Json), ...(f as Json) }))
    : [];
  if (arr.length === 0) throw new Error("GISTDA คืนรูปแบบที่ไม่รู้จัก: " + JSON.stringify(raw).slice(0, 200));

  // เก็บดิบไว้ด้วย เผื่อโครงสร้างเปลี่ยนจะได้ไล่ดูได้
  if (!ctx.dry) await ctx.sb.from("api_cache").upsert({ cache_key: "gistda_pm25:provinces", source_id: "gistda_pm25", payload: raw as Json, fetched_at: new Date().toISOString() });

  const stRows: Json[] = [], latest: Json[] = [], obs: Json[] = [];
  const now = new Date().toISOString();
  for (const it of arr) {
    const name = String(pick(it, ["pv_tn", "province", "province_th", "name_th", "name", "pv_name"]) ?? "").trim();
    let lat = num(pick(it, ["lat", "latitude", "y"])), lng = num(pick(it, ["lng", "lon", "long", "longitude", "x"]));
    if ((lat === null || lng === null) && PROVINCE_CENTROID[name]) [lat, lng] = PROVINCE_CENTROID[name];
    if (!name || lat === null || lng === null) continue;
    const pm = num(pick(it, ["pm25", "pm2_5", "pm25_value", "value", "avg"]));
    const atRaw = pick(it, ["datetime", "date_time", "time", "date", "datetime_th", "dt"]);
    const at = atRaw ? (arcgisTime(atRaw) ?? now) : now;
    stRows.push({ ext_id: name, name_th: name, province: name, station_type: "province", lat, lng, meta: { level: "province", approx_centroid: true } });
    obs.push({ ext: name, at, pm });
  }
  const ids = await upsertStations(ctx, "gistda_pm25", stRows);
  const obsRows: Json[] = [];
  for (const o of obs) {
    const id = ids.get(String(o.ext)); if (!id) continue;
    obsRows.push({ station_id: id, observed_at: o.at, parameter: "PM25", value: o.pm, unit: "µg/m³", quality: o.pm === null ? "missing" : "ok" });
    latest.push({ station_id: id, parameter: "PM25", observed_at: o.at, value: o.pm, unit: "µg/m³", extra: { satellite: true } });
  }
  const n = await upsert(ctx, "observations", obsRows, "station_id,parameter,observed_at");
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  return { rows: n, note: `จังหวัด ${stRows.length}` };
}

/** GISTDA hotspot (ArcGIS MapServer) — MODIS และ VIIRS ใช้ handler เดียว ต่างกันที่ url */
async function gistda_hotspot(ctx: Ctx): Promise<HandlerResult> {
  const base = String(ctx.source.url).replace(/\/query.*$/, "");
  const rows: Json[] = [];
  let offset = 0;
  for (let page = 0; page < 30; page++) {                // กันวนไม่รู้จบ: สูงสุด 30,000 จุด
    const url = `${base}/query?where=1%3D1&outFields=*&outSR=4326&f=json&resultOffset=${offset}&resultRecordCount=1000`;
    const j = await fetchJson(url) as { features?: Json[]; exceededTransferLimit?: boolean; error?: Json };
    if (j.error) throw new Error("ArcGIS: " + JSON.stringify(j.error));
    const feats = j.features ?? [];
    for (const f of feats) {
      const a = (f.attributes ?? {}) as Json, g = (f.geometry ?? {}) as Json;
      const lat = num(pick(a, ["latitude", "lat", "y"])) ?? num(g.y);
      const lng = num(pick(a, ["longitude", "long", "lon", "lng", "x"])) ?? num(g.x);
      if (lat === null || lng === null) continue;
      const at = arcgisTime(pick(a, ["acq_date", "hotspot_date", "date", "datetime", "acq_datetime"]), pick(a, ["acq_time", "time"]))
             ?? new Date().toISOString();
      const frp = num(pick(a, ["frp", "brightness", "bright_ti4", "confidence"]));
      rows.push({
        source_id: String(ctx.source.id), kind: "hotspot",
        ext_id: `${lat.toFixed(4)}|${lng.toFixed(4)}|${at}`,
        occurred_at: at, lat, lng, magnitude: frp,
        province: (pick(a, ["pv_tn", "province", "changwat", "pv_name"]) as string) ?? null,
        title: (pick(a, ["satellite", "instrument"]) as string) ?? null,
        props: a,
      });
    }
    offset += feats.length;
    if (!j.exceededTransferLimit || feats.length === 0) break;
  }
  const n = await upsert(ctx, "events", rows, "source_id,ext_id");
  return { rows: n };
}

/** แผ่นดินไหว TMD — RSS */
async function tmd_quake(ctx: Ctx): Promise<HandlerResult> {
  const xml = await fetchText(String(ctx.source.url));
  const items = xml.split(/<item>/i).slice(1);
  const tag = (s: string, t: string) => {
    const m = s.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`, "i"));
    return m ? m[1].trim() : null;
  };
  const rows: Json[] = [];
  for (const it of items) {
    const lat = num(tag(it, "geo:lat")), lng = num(tag(it, "geo:long"));
    if (lat === null || lng === null) continue;
    const tmdTime = tag(it, "tmd:time");                   // "2026-09-03 10:15:30 UTC" หรือเวลาไทย
    let at: string | null = null;
    if (tmdTime) {
      const d = new Date(tmdTime.replace(" UTC", "Z").replace(" ", "T"));
      at = Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (!at) { const d = new Date(tag(it, "pubDate") ?? ""); at = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); }
    const link = tag(it, "link") ?? tag(it, "guid") ?? `${lat}|${lng}|${at}`;
    rows.push({
      source_id: "tmd_quake", kind: "earthquake", ext_id: link, occurred_at: at, lat, lng,
      magnitude: num(tag(it, "tmd:magnitude")), title: tag(it, "title"),
      props: { depth_km: num(tag(it, "tmd:depth")), description: tag(it, "description"), link },
    });
  }
  const n = await upsert(ctx, "events", rows, "source_id,ext_id");
  return { rows: n };
}

/** บ่อน้ำบาดาล DGR — 118 หน้า ดึงทีละ 8 หน้าต่อรอบ จำหน้าไว้ใน cursor */
async function dgr_wells(ctx: Ctx): Promise<HandlerResult> {
  const PAGES_PER_RUN = 8;
  let page = Number(ctx.cursor?.next_page ?? 1);
  let lastPage = Number(ctx.cursor?.last_page ?? 0);
  const rows: Json[] = [];
  for (let i = 0; i < PAGES_PER_RUN; i++) {
    const url = `${String(ctx.source.url)}?page=${page}`;
    const j = await fetchJson(url) as Json;
    const data = (Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : []) as Json[];
    lastPage = Number(j.last_page ?? lastPage ?? 0);
    for (const w of data) {
      const lat = num(pick(w, ["lat", "latitude"])), lng = num(pick(w, ["long", "lng", "longitude"]));
      if (lat === null || lng === null || lat < 5 || lat > 21 || lng < 97 || lng > 106) continue;
      rows.push({
        ext_id: String(pick(w, ["no", "well_no", "id"]) ?? `${lat},${lng}`),
        name_th: (pick(w, ["locat", "location", "name"]) as string) ?? null,
        area_th: [w.tumbolname, w.ampurname, w.provincenam].filter(Boolean).join(" "),
        province: (w.provincenam as string) ?? null, station_type: "well", lat, lng,
        meta: { depth_drill_m: num(w.deeptdrill), depth_dev_m: num(w.deepdev), yield_m3h: num(w.yiel),
                static_m: num(w.static), well_type: w.welltypename, wdd: w.wdd },
      });
    }
    if (data.length === 0 || (lastPage && page >= lastPage) || !j.next_page_url) { page = 0; break; }
    page++;
  }
  const n = (await upsertStations(ctx, "dgr_wells", rows)).size;
  const next = page === 0 ? 1 : page;
  return { rows: rows.length, cursor: { next_page: next, last_page: lastPage, completed: page === 0 },
           note: `ถึงหน้า ${page === 0 ? lastPage + " (ครบ วนใหม่)" : page - 1} จาก ${lastPage || "?"} · สถานีทั้งหมด ${n}` };
}

/** เรดาร์ฝนหลวง — เก็บ URL รูปล่าสุดต่อสถานีใน latest_observations.extra */
async function royalrain(ctx: Ctx): Promise<HandlerResult> {
  const raw = await fetchJson(String(ctx.source.url));
  const arr = (Array.isArray(raw) ? raw : Array.isArray((raw as Json).data) ? (raw as Json).data : [raw]) as Json[];
  const stRows = Object.entries(RADAR_STATIONS).map(([k, v]) => ({ ext_id: k, name_th: v.name, station_type: "radar", lat: v.lat, lng: v.lng, meta: { approx: true } }));
  const ids = await upsertStations(ctx, "royalrain_radar", stRows);
  const latest: Json[] = [];
  for (const it of arr) {
    const key = String(it.station ?? "").toLowerCase();
    const id = ids.get(key); if (!id) continue;
    const at = it.datetime_utc ? new Date(String(it.datetime_utc).replace(" ", "T") + (String(it.datetime_utc).endsWith("Z") ? "" : "Z")) : new Date();
    latest.push({ station_id: id, parameter: "radar", observed_at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
                  value: null, unit: "image", extra: { url: it.url, datetime_bangkok: it.datetime_bangkok } });
  }
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  return { rows: latest.length };
}

/** TMD WeatherToday / Weather3Hours — ต้องมี TMD_UID / TMD_UKEY ใน Secrets */
async function tmd_obs(ctx: Ctx): Promise<HandlerResult> {
  const uid = Deno.env.get("TMD_UID"), ukey = Deno.env.get("TMD_UKEY");
  if (!uid || !ukey) throw new Error("ยังไม่ได้ตั้ง Secrets TMD_UID / TMD_UKEY (สมัครที่ data.tmd.go.th)");
  const url = `${String(ctx.source.url)}?uid=${encodeURIComponent(uid)}&ukey=${encodeURIComponent(ukey)}&format=json`;
  const j = await fetchJson(url) as Json;
  const list = ((j.Stations as Json)?.Station ?? (j.Station as Json[]) ?? []) as Json[];
  if (list.length === 0) throw new Error("TMD คืนสถานีว่าง: " + JSON.stringify(j).slice(0, 200));
  const stRows: Json[] = [], per: { ext: string; at: string; vals: Record<string, number | null> }[] = [];
  const F: Record<string, string[]> = {
    tc: ["Temperature"], tmax: ["MaxTemperature"], tmin: ["MinTemperature"], rh: ["RelativeHumidity"],
    wd: ["WindDirection"], ws: ["WindSpeed"], rain: ["Rainfall"], slp: ["MeanSeaLevelPressure"],
  };
  for (const s of list) {
    const lat = num(s.Latitude), lng = num(s.Longitude); if (lat === null || lng === null) continue;
    const ext = String(s.WmoStationNumber ?? s.StationID ?? s.StationNameThai);
    stRows.push({ ext_id: ext, name_th: s.StationNameThai, name_en: s.StationNameEnglish, province: s.Province, station_type: "synop", lat, lng, meta: {} });
    const obs = (s.Observe ?? s) as Json;
    const at = arcgisTime(obs.DateTime ?? s.DateTime) ?? new Date().toISOString();
    const vals: Record<string, number | null> = {};
    for (const [k, keys] of Object.entries(F)) vals[k] = num(pick(obs, keys));
    per.push({ ext, at, vals });
  }
  const ids = await upsertStations(ctx, String(ctx.source.id), stRows);
  const U: Record<string, string> = { tc: "°C", tmax: "°C", tmin: "°C", rh: "%", wd: "°", ws: "km/h", rain: "mm", slp: "hPa" };
  const obsRows: Json[] = [], latest: Json[] = [];
  for (const p of per) {
    const id = ids.get(p.ext); if (!id) continue;
    for (const [k, v] of Object.entries(p.vals)) {
      obsRows.push({ station_id: id, observed_at: p.at, parameter: k, value: v, unit: U[k], quality: v === null ? "missing" : "ok" });
      latest.push({ station_id: id, parameter: k, observed_at: p.at, value: v, unit: U[k], extra: {} });
    }
  }
  const n = await upsert(ctx, "observations", obsRows, "station_id,parameter,observed_at");
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  return { rows: n, note: `สถานี ${stRows.length}` };
}

async function not_ready(_ctx: Ctx): Promise<HandlerResult> {
  throw new Error("handler นี้อยู่ในเฟสถัดไป (ต้องมี api key) — ดู docs/แหล่งข้อมูลราชการ.md");
}

const HANDLERS: Record<string, (c: Ctx) => Promise<HandlerResult>> = {
  air4thai, gistda_pm25, gistda_hotspot, tmd_quake, dgr_wells, royalrain,
  tmd_today: tmd_obs, tmd_3h: tmd_obs,
  gistda_flood: not_ready, firms: not_ready, tmd_nwp: not_ready,
};

// ─────────────────────────────────────────────────────────── ตัวหลัก

Deno.serve(async (req: Request) => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ ok: false, error: "POST เท่านั้น", version: VERSION }, 405);

  const token = Deno.env.get("ENVI_CRON_TOKEN");
  const auth = req.headers.get("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) return json({ ok: false, error: "token ไม่ถูกต้อง" }, 401);

  let body: Json = {};
  try { body = await req.json(); } catch { /* ว่างได้ */ }
  const sourceId = String(body.source ?? "");
  const dry = body.dry === true;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: source, error: srcErr } = await sb.from("sources").select("*").eq("id", sourceId).maybeSingle();
  if (srcErr || !source) return json({ ok: false, error: `ไม่มีแหล่ง '${sourceId}' ใน sources` }, 404);
  const handler = HANDLERS[String(source.handler ?? "")];
  if (!handler) return json({ ok: false, error: `แหล่ง '${sourceId}' ไม่มี handler (${source.handler})` }, 400);

  // cursor ของรอบก่อน (แหล่งที่ดึงหลายรอบ)
  const { data: prev } = await sb.from("ingest_runs").select("cursor").eq("source_id", sourceId).eq("ok", true)
    .not("cursor", "is", null).order("started_at", { ascending: false }).limit(1).maybeSingle();

  const started = new Date().toISOString();
  const ctx: Ctx = { sb, source: source as Json, dry, cursor: (prev?.cursor as Json) ?? null };
  let result: HandlerResult | null = null, error: string | null = null;
  try {
    result = await handler(ctx);
  } catch (e) {
    error = (e as Error).message ?? String(e);
  }

  if (!dry) {
    await sb.from("ingest_runs").insert({
      source_id: sourceId, fn_version: VERSION, started_at: started, finished_at: new Date().toISOString(),
      rows_upserted: result?.rows ?? 0, ok: error === null, error,
      cursor: result?.cursor ?? null,
    });
  }
  return json({ ok: error === null, source: sourceId, dry, version: VERSION, rows: result?.rows ?? 0, note: result?.note ?? null, cursor: result?.cursor ?? null, error });
});
