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

export const VERSION = "1.4.0"; // 1.0.1: CA YR1 air4thai · 1.1.0: action forecast (TMD NWP) + CORS · 1.2.0: GISTDA flood layer + action burnscar · 1.2.1: dedupe ก่อน upsert (DGR) · 1.3.0: handler pcd_dspot · 1.4.0: handler diw_poms (เซนเซอร์โรงงาน) + pcd_iwis (สถานีแม่น้ำ)

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

/**
 * ใบรับรอง CA เพิ่มเติม — เซิร์ฟเวอร์ราชการบางแห่ง (air4thai.pcd.go.th) ใช้ใบรับรอง Let's Encrypt
 * รุ่นใหม่ (intermediate "YR1" ราก "ISRG Root YR", ออก ก.ย. 2568) แต่ส่ง chain ผิด (ส่งของ Sectigo มาแทน)
 * เบราว์เซอร์/curl หา intermediate เองได้ (AIA) แต่ Deno/rustls ไม่ทำ → "invalid peer certificate: UnknownIssuer"
 * จึงใส่ YR1 เป็น trust anchor เพิ่ม (ดาวน์โหลดจาก http://yr1.i.lencr.org/ 3 ก.ย. 2569 · หมดอายุ 2 ก.ย. 2571)
 */
const EXTRA_CA_CERTS = [`-----BEGIN CERTIFICATE-----
MIIE2zCCAsOgAwIBAgIRAKICU/FfJpHAXcHOE7m8yk4wDQYJKoZIhvcNAQELBQAw
LjELMAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWVIw
HhcNMjUwOTAzMDAwMDAwWhcNMjgwOTAyMjM1OTU5WjAzMQswCQYDVQQGEwJVUzEW
MBQGA1UEChMNTGV0J3MgRW5jcnlwdDEMMAoGA1UEAxMDWVIxMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoVi8X2xCYgMXvJxNPKp/oF13UMgmPABB07VC
LNDtoXmt9luEZNJSBV10VyT1Pz6LD8Zq1d2gc43WNl1AdRrj4sEnazbOiz0nPpmG
Bp2hui49oZtDIY6wdKeZAi5BbNU20CH6RSBBMLSQ9cXrH8dxdv4PAJ45ssGML68U
SE3BsjC2a6cAN9L5CgXVIQi5tfNiTPoFZZ3S0OlXqLmmtdV95udWAb5b6e/F49Di
CsH0Y00Ag72BVIb1hzynmKe+X0mERBTtsb3BwmpV9ipeBjMLoR/D9cHxHQCWoi5l
TmXwY015J5rGelz1nZjJuxc2kioaX29XJBnhMkP531rSdG5uMwIDAQABo4HuMIHr
MA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEFBQcDATASBgNVHRMBAf8E
CDAGAQH/AgEAMB0GA1UdDgQWBBQfLzW+RhSCzUCxrnksVXj699Ro+zAfBgNVHSME
GDAWgBTe51tg0CJtQCh9Pw0B/qS1UrRRlDAyBggrBgEFBQcBAQQmMCQwIgYIKwYB
BQUHMAKGFmh0dHA6Ly95ci5pLmxlbmNyLm9yZy8wEwYDVR0gBAwwCjAIBgZngQwB
AgEwJwYDVR0fBCAwHjAcoBqgGIYWaHR0cDovL3lyLmMubGVuY3Iub3JnLzANBgkq
hkiG9w0BAQsFAAOCAgEA0+zvMq3kHig1ddTmmm+RibTr9/RpX7k4buanMMRqbV/y
IvP82zAHN3mvaw+cASuVsdpd0ikjhr4hnhJQLQOzOp2ccKrsdGOAgo0vddeISFAq
EWEV4lmUM3vFF796up+bSgmJ1u6RupDCMxDgF8M3eLvGuj6L0lu3zkQ0KuQLnKxL
tB0oQqn1Idg5CuuGpMvQzk29Pa3D/qHurc0EIM9SxukQuJqq63lxsYyRQFU8yMBO
hq1w5LbfaWNRrz1uklOfI/pYkAb2E2MTZrAMQkBIE2S8Jt1F8gRc96o/xOsrgvSk
a84AisX6xq1lz1Z7jGvrnXc4TMcjxZTjiTaihcYI1JIXZiLtEMSCa5l3cu8YWd6z
dLRQlqRdclVjuQfNHawRJ6GWlkK0QJosivTKwdBw3KxEtzGo8yMHERbsy57gP1UX
HOMcmZYQC0gtyR3SxfenIM/MxC3Ia2Ypab/kQ/CTnlIn2KQ5JUC6NYrGCbhFN9bp
5lKJStEwCUnLpntcrXk5XVDCNv/5RyWpRThkGOV7GetKkQ0qAY8hCzWK6oqnAhDZ
cjlYVdWfqOw3DIOX6EDNBgAqHarRVxyF9QZdOaXSyPJ0ueD2BYJEBgaCGQ8rAaU/
Qc123V5LTXDZW4CcsPBDyhy4v+c8hClAyw/IkJlfBqxB9D+/wvIMHgECZ4ptP6o=
-----END CERTIFICATE-----`];

/** HTTP client ที่รู้จัก CA เพิ่มเติม — ถ้า runtime ไม่รองรับ createHttpClient ก็ใช้ fetch ปกติ */
let _httpClient: Deno.HttpClient | null | undefined;
function httpClient(): Deno.HttpClient | undefined {
  if (_httpClient !== undefined) return _httpClient ?? undefined;
  try {
    _httpClient = Deno.createHttpClient({ caCerts: EXTRA_CA_CERTS });
  } catch (e) {
    console.warn("createHttpClient ไม่ได้ ใช้ fetch ปกติ:", (e as Error).message);
    _httpClient = null;
  }
  return _httpClient ?? undefined;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(url, { ...init, client: httpClient(), headers: { "User-Agent": "envi-pi/" + VERSION, ...(init?.headers ?? {}) } } as RequestInit);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`ไม่ใช่ JSON (${text.slice(0, 80)}) ${url}`); }
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { client: httpClient(), headers: { "User-Agent": "envi-pi/" + VERSION } } as RequestInit);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

function chunk<T>(a: T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/** ตัดแถวที่คีย์ onConflict ซ้ำกันในชุดเดียว (แถวหลังชนะ) — Postgres ปฏิเสธ "ON CONFLICT DO UPDATE command cannot affect row a second time" (เจอจริงกับ DGR หน้า 8) */
function dedupe(rows: Json[], onConflict: string): Json[] {
  const cols = onConflict.split(",").map((c) => c.trim());
  const m = new Map<string, Json>();
  for (const r of rows) m.set(cols.map((c) => String(r[c] ?? "")).join(""), r);
  return [...m.values()];
}

async function upsert(ctx: Ctx, table: string, rows: Json[], onConflict: string): Promise<number> {
  rows = dedupe(rows, onConflict);
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
  // ⚠️ MapServer ของ GISTDA ตอบ "Pagination is not supported" ทั้ง resultOffset และ resultRecordCount
  //    แต่ maxRecordCount = 1000 → แบ่งหน้าเองด้วย where FID > <FID สูงสุดของหน้าก่อน> (ตรวจ 3 ก.ย. 2569)
  //    ฟิลด์จริง: longitude latitude FID confident satellite datetime(epoch ms) region lu_name tb_tb ap_tn pv_tn
  let lastFid = -1;
  for (let page = 0; page < 30; page++) {                // กันวนไม่รู้จบ: สูงสุด 30,000 จุด
    const where = encodeURIComponent(lastFid < 0 ? "1=1" : `FID > ${lastFid}`);
    const url = `${base}/query?where=${where}&outFields=*&outSR=4326&f=json`;
    const j = await fetchJson(url) as { features?: Json[]; exceededTransferLimit?: boolean; error?: Json; objectIdFieldName?: string };
    if (j.error) throw new Error("ArcGIS: " + JSON.stringify(j.error));
    const feats = j.features ?? [];
    let pageMaxFid = lastFid;
    for (const f of feats) {
      const a = (f.attributes ?? {}) as Json, g = (f.geometry ?? {}) as Json;
      const fid = num(pick(a, [j.objectIdFieldName ?? "FID", "FID", "OBJECTID"]));
      if (fid !== null && fid > pageMaxFid) pageMaxFid = fid;
      const gp = Array.isArray(g.points) ? (g.points as number[][])[0] : null;   // esriGeometryMultipoint
      const lat = num(pick(a, ["latitude", "lat", "y"])) ?? num(g.y) ?? (gp ? num(gp[1]) : null);
      const lng = num(pick(a, ["longitude", "long", "lon", "lng", "x"])) ?? num(g.x) ?? (gp ? num(gp[0]) : null);
      if (lat === null || lng === null) continue;
      const at = arcgisTime(pick(a, ["acq_date", "hotspot_date", "date", "datetime", "acq_datetime"]), pick(a, ["acq_time", "time"]))
             ?? new Date().toISOString();
      const frp = num(pick(a, ["frp", "brightness", "bright_ti4", "confident", "confidence"]));
      rows.push({
        source_id: String(ctx.source.id), kind: "hotspot",
        ext_id: `${lat.toFixed(4)}|${lng.toFixed(4)}|${at}`,
        occurred_at: at, lat, lng, magnitude: frp,
        province: (pick(a, ["pv_tn", "province", "changwat", "pv_name"]) as string) ?? null,
        title: (pick(a, ["satellite", "instrument"]) as string) ?? null,
        props: a,
      });
    }
    if (feats.length < 1000 || pageMaxFid === lastFid) break;   // หน้าสุดท้าย หรือหา FID ไม่เจอ
    lastFid = pageMaxFid;
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

/**
 * บ่อน้ำบาดาล DGR — API แบ่งหน้าเพี้ยน (ตรวจ 3 ก.ย. 2569):
 *   ?Page=N คืนแถวตั้งแต่ offset (N-1)×1000 จำนวน N×1000 แถว (Page=60 คืน 58,723 แถว!) ไม่มีพารามิเตอร์ขนาดหน้า
 *   → ครอบคลุมทั้ง 117,617 แถวด้วยลำดับหน้า 1,2,4,8,16,32,64 (ช่วง [(N-1)k, (2N-1)k) ต่อกันพอดี)
 *   หน้าใหญ่ (64 ≈ 55k แถว) เกินเวลา CPU ของ Edge ถ้า upsert ทีเดียว → แต่ละรอบ upsert แค่ 10,000 แถว
 *   จำตำแหน่งใน cursor {seq_idx, offset} · ครบทั้งลำดับแล้ววนใหม่ (cron รายชั่วโมง ≈ 16 รอบต่อรอบใหญ่)
 *   โครงสร้างจริง: { total, last_page_url, next_page_url, result: [...] } — แถวอยู่ใน "result"
 */
async function dgr_wells(ctx: Ctx): Promise<HandlerResult> {
  const SEQ = [1, 2, 4, 8, 16, 32, 64], SLICE = 10000;
  let idx = Math.min(Number(ctx.cursor?.seq_idx ?? 0), SEQ.length - 1);
  let offset = Number(ctx.cursor?.offset ?? 0);
  const page = SEQ[idx];
  const j = await fetchJson(`${String(ctx.source.url)}?Page=${page}`) as Json;
  const data = (Array.isArray(j.result) ? j.result : Array.isArray(j.data) ? j.data : []) as Json[];
  const slice = data.slice(offset, offset + SLICE);
  const rows: Json[] = [];
  for (const w of slice) {
    const lat = num(pick(w, ["lat", "latitude"])), lng = num(pick(w, ["long", "lng", "longitude"]));
    if (lat === null || lng === null || lat < 5 || lat > 21 || lng < 97 || lng > 106) continue;
    rows.push({
      ext_id: String(pick(w, ["no", "well_no", "id"]) ?? `${lat},${lng}`),
      name_th: (pick(w, ["locat", "location", "name"]) as string) ?? null,
      area_th: [w.mubanname && ("บ้าน" + w.mubanname), w.tumbolname && ("ต." + w.tumbolname),
                w.ampurname && ("อ." + w.ampurname), w.provincenam && ("จ." + w.provincenam)].filter(Boolean).join(" "),
      province: (w.provincenam as string) ?? null, station_type: "well", lat, lng,
      meta: { depth_drill_m: num(w.deeptdrill), depth_dev_m: num(w.deepdev), yield_m3h: num(w.yiel),
              static_m: num(w.static), well_type: w.welltypename, water: w.bwdname ?? null, wdd: w.wdd || null },
    });
  }
  const total = (await upsertStations(ctx, "dgr_wells", rows)).size;
  const done = Math.min(offset + SLICE, data.length);
  offset += SLICE;
  let completed = false;
  if (offset >= data.length) { offset = 0; idx++; }
  if (idx >= SEQ.length) { idx = 0; completed = true; }
  return {
    rows: rows.length,
    cursor: { seq_idx: idx, offset, last_page: page, api_total: j.total ?? null, completed },
    note: `หน้า ${page}: แถว ${done}/${data.length} · ในฐาน ${total} บ่อ${completed ? " · ครบรอบ วนใหม่" : ""}`,
  };
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

/**
 * GISTDA api-gateway (ต้องมี Secret GISTDA_API_KEY — ตรวจ 3 ก.ย. 2569)
 *   key ส่งเป็น query `api_key=` หรือ header `API-Key` ได้ทั้งคู่
 *   flood: STAC `resources/stac/flood/collections/flood1day_r2/items` → item เดียว `items_flood1day_r2`
 *          assets.data = GeoJSON พื้นที่น้ำท่วมทั้งประเทศจากภาพดาวเทียม (วันไม่มีน้ำท่วม = FeatureCollection ว่าง)
 *          flood3day/7day/30day มี collection แต่ไม่มี item (ณ วันตรวจ) · gi-service/<ver>/flood-recurrence ตอบ 404
 *          ⚠️ ห้ามเขียนเครื่องหมายทับ-ดาว-ทับ (slash star slash) ในคอมเมนต์ — bundler อ่านเป็นปิดคอมเมนต์ (deploy ล้ม 3 ก.ย. 2569)
 *   burn-scar: `resources/features/burn-scar?bbox=&limit=` 79,435 โพลิกอน (props: date "YYYYMMDD - YYYYMMDD", area_rai, lu_name, pv_tn, ap_tn, tb_tn)
 */
const GISTDA = "https://api-gateway.gistda.or.th/api/2.0";
function gistdaKey(): string {
  const k = Deno.env.get("GISTDA_API_KEY");
  if (!k) throw new Error("ยังไม่ได้ตั้ง Secret GISTDA_API_KEY (สมัครที่ api-gateway.gistda.or.th)");
  return k;
}

/** พื้นที่น้ำท่วมรายวัน → แทนที่ชั้น gistda_flood_1d ทั้งชั้น (ผ่าน RPC replace_layer_features ที่ service_role เท่านั้น) */
async function gistda_flood(ctx: Ctx): Promise<HandlerResult> {
  const key = gistdaKey();
  const items = await fetchJson(`${GISTDA}/resources/stac/flood/collections/flood1day_r2/items?limit=1&api_key=${key}`) as Json;
  const item = ((items.features as Json[]) ?? [])[0];
  if (!item) throw new Error("STAC flood1day_r2 ไม่มี item");
  const href = ((item.assets as Json)?.data as Json)?.href as string | undefined;
  if (!href) throw new Error("item ไม่มี assets.data");
  const gj = await fetchJson(href) as Json;
  const feats = ((gj.features as Json[]) ?? []).map((f) => ({ ...f, properties: { ...(f.properties as Json ?? {}), datetime: (item.properties as Json)?.datetime ?? null } }));
  if (ctx.dry) return { rows: feats.length, note: `datetime ${(item.properties as Json)?.datetime} · ${feats.length} โพลิกอน (dry)` };
  const { data, error } = await ctx.sb.rpc("replace_layer_features", {
    p_layer: "gistda_flood_1d", p_features: feats, p_name_key: "name", p_ext_key: null,
    p_layer_row: { source_id: "gistda_flood", name_th: "พื้นที่น้ำท่วมจากดาวเทียม 1 วัน (GISTDA)", style: { fill: "#2979ff", opacity: 0.45 },
      notes: `ภาพ ณ ${(item.properties as Json)?.datetime} · อัปเดตอัตโนมัติทุก 6 ชม.` },
  });
  if (error) throw new Error("replace_layer_features: " + error.message);
  return { rows: Number((data as Json)?.inserted ?? 0), note: `datetime ${(item.properties as Json)?.datetime} · ข้าม ${(data as Json)?.skipped ?? 0}` };
}

/** รอยไหม้รอบจุด (action สาธารณะ) — bbox ±0.045° (~5 กม.) แคช 24 ชม. */
async function burnScarAt(sb: SupabaseClient, lat: number, lng: number): Promise<Json> {
  const cacheKey = `gistda_burnscar:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const { data: hit } = await sb.from("api_cache").select("payload, fetched_at").eq("cache_key", cacheKey).maybeSingle();
  if (hit && Date.now() - new Date(hit.fetched_at).getTime() < 86400e3) return { ...(hit.payload as Json), cached: true, fetched_at: hit.fetched_at };
  const d = 0.045;
  const bbox = `${(lng - d).toFixed(4)},${(lat - d).toFixed(4)},${(lng + d).toFixed(4)},${(lat + d).toFixed(4)}`;
  const j = await fetchJson(`${GISTDA}/resources/features/burn-scar?bbox=${bbox}&limit=200&api_key=${gistdaKey()}`) as Json;
  const feats = ((j.features as Json[]) ?? []);
  const byLu: Record<string, number> = {};
  let rai = 0, latest = "";
  for (const f of feats) {
    const p = (f.properties ?? {}) as Json;
    rai += Number(p.area_rai) || 0;
    const lu = String(p.lu_name ?? "ไม่ระบุ"); byLu[lu] = (byLu[lu] || 0) + (Number(p.area_rai) || 0);
    if (String(p.date ?? "") > latest) latest = String(p.date ?? "");
  }
  const payload: Json = {
    source: "GISTDA burn-scar (รอยไหม้จากภาพดาวเทียม)", bbox, radius_km: 5,
    count: Number(j.numberMatched ?? feats.length), area_rai: Math.round(rai * 10) / 10, latest_period: latest || null,
    by_landuse: Object.entries(byLu).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({ lu: k, rai: Math.round(v * 10) / 10 })),
    features: feats.slice(0, 60).map((f) => ({ type: "Feature", geometry: f.geometry,
      properties: { date: (f.properties as Json)?.date, area_rai: (f.properties as Json)?.area_rai, lu_name: (f.properties as Json)?.lu_name, tb_tn: (f.properties as Json)?.tb_tn, ap_tn: (f.properties as Json)?.ap_tn } })),
  };
  await sb.from("api_cache").upsert({ cache_key: cacheKey, source_id: "gistda_burnscar", payload, fetched_at: new Date().toISOString() });
  return { ...payload, cached: false, fetched_at: new Date().toISOString() };
}

/**
 * คพ. DSPOT — ระบบบำบัดน้ำเสียรวมชุมชน/กลุ่มอาคาร ทั้งประเทศ (216 ระบบ, รายงานปีล่าสุด)
 *   หน้า https://dspot.pcd.go.th/database/s?area= เป็น Next.js ฝัง JSON ใน <script id="__NEXT_DATA__"> → props.pageProps.reports[]
 *   ไม่ใช้ /_next/data/<buildId>/…json เพราะ buildId เปลี่ยนทุก deploy · ไม่มี CORS จึงต้องผ่านที่นี่
 *   → stations (station_type wwtp, meta = รายงานทั้งก้อนแบบตัดฟิลด์รูป) + observations คุณภาพน้ำ ณ วันตรวจ (date_quality)
 */
async function pcd_dspot(ctx: Ctx): Promise<HandlerResult> {
  const html = await fetchText(String(ctx.source.url));
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("ไม่พบ __NEXT_DATA__ ในหน้า DSPOT (โครงสร้างหน้าเปลี่ยน?)");
  const nd = JSON.parse(m[1]) as Json;
  const reports = ((nd.props as Json)?.pageProps as Json)?.reports as Json[] | undefined;
  if (!Array.isArray(reports) || reports.length === 0) throw new Error("DSPOT reports ว่าง");

  const stRows: Json[] = [];
  const byExt = new Map<string, Json>();
  for (const r of reports) {
    const lat = num(r.lat), lng = num(r.lng);
    if (lat === null || lng === null || lat < 5 || lat > 21 || lng < 97 || lng > 106) continue;
    const ext = String(r.plant_id ?? r._id);
    const meta: Json = {
      manage_type: r.manage_type ?? null, status: r.wwt_status ?? null, plant_type: r.plant_type ?? null, operator: r.unit_op ?? null,
      level_gov: r.level_gov ?? null, local_name: r.local_name ?? null, region: r.region ?? null, zone: r.zone ?? null,
      capacity: num(r.capacity), inflow_pct: num(r.p_inflow), avg_inflow: num(r.avg_collect_waste), pop: num(r.total_pop), service_pct: num(r.p_service_area),
      basin: r.basin || null, river: r.river || null, discharge: r.discharge_place || null, year_op: num(r.year_op), cost_mb: num(r.total_const_cost),
      fund: r.unit_fund || null, fee: r.fee_charge || null, location: r.location || null, report_year: num(r.report_year), report_status: r.report_status ?? null,
      date_quality: r.date_quality || null,
      wq: { bod_in: num(r.bod_inflow), bod_out: num(r.bod_discharge), tss_in: num(r.tss_inflow), tss_out: num(r.tss_discharge), ph_in: num(r.ph_inflow), ph_out: num(r.ph_discharge),
            tn_in: num(r.tn_inflow), tn_out: num(r.tn_discharge), tp_in: num(r.tp_inflow), tp_out: num(r.tp_discharge), fog_in: num(r.fog_inflow), fog_out: num(r.fog_discharge) },
      remark: typeof r.remark_general === "string" ? r.remark_general.slice(0, 400) : null,
      photo: Array.isArray(r.plant_photos) && (r.plant_photos[0] as Json)?.photo_src ? (r.plant_photos[0] as Json).photo_src : null,
    };
    stRows.push({ ext_id: ext, name_th: r.plant_name ?? r.local_name ?? ext, area_th: [r.local_name, r.province && ("จ." + r.province)].filter(Boolean).join(" "),
      province: r.province ?? null, station_type: "wwtp", lat, lng, meta });
    byExt.set(ext, r);
  }
  const ids = await upsertStations(ctx, "pcd_dspot", stRows);

  // observations: ค่าน้ำ ณ วันตรวจ (ถ้าไม่มีวันตรวจใช้ 1 ม.ค. ของปีรายงาน ค.ศ.)
  const PARAMS: [string, string, string][] = [["bod_in", "bod_inflow", "mg/L"], ["bod_out", "bod_discharge", "mg/L"], ["tss_in", "tss_inflow", "mg/L"], ["tss_out", "tss_discharge", "mg/L"],
    ["ph_in", "ph_inflow", ""], ["ph_out", "ph_discharge", ""], ["inflow_pct", "p_inflow", "%"], ["avg_inflow", "avg_collect_waste", "m³/d"]];
  const obs: Json[] = [], latest: Json[] = [];
  for (const [ext, r] of byExt) {
    const id = ids.get(ext);
    if (!id) continue;
    const dq = String(r.date_quality ?? "");
    const yr = num(r.report_year); const ce = yr === null ? null : (yr > 2400 ? yr - 543 : yr);
    const at = /^\d{4}-\d{2}-\d{2}$/.test(dq) ? `${dq}T00:00:00+07:00` : ce ? `${ce}-01-01T00:00:00+07:00` : null;
    if (!at) continue;
    for (const [p, key, unit] of PARAMS) {
      const v = num(r[key]);
      if (v === null) continue;                                   // ไม่เก็บค่าว่าง/"-" (รายงานส่วนใหญ่ไม่มี TSS)
      obs.push({ station_id: id, observed_at: at, parameter: p, value: v, unit, quality: "ok" });
      latest.push({ station_id: id, parameter: p, observed_at: at, value: v, unit, extra: { report_year: yr } });
    }
  }
  const n1 = await upsert(ctx, "observations", obs, "station_id,parameter,observed_at");
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  const running = stRows.filter((s) => (s.meta as Json).status === "เดินระบบ").length;
  return { rows: stRows.length, note: `ระบบ ${stRows.length} (เดินระบบ ${running}) · ค่าน้ำ ${n1} · buildId ${nd.buildId ?? "?"}` };
}

/** วนเรียก fn กับทุก item พร้อมกันสูงสุด n งาน (ไม่มี p-limit ใน Deno) */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/**
 * กรมโรงงานฯ POMS — เซนเซอร์ต่อเนื่องในโรงงาน (WPMS น้ำทิ้ง: COD/BOD/Flow/Watt · CEMS ปล่อง: O2/ฝุ่น/CO/SO2/NOx)
 *   factory-ws/get/factory-list?page=N (50/หน้า ≈ 800 โรงงาน, geom "POINT(lng lat)") · get/measurement-list/{id} = ค่าล่าสุดต่อจุดวัด
 *   ไม่ต้องล็อกอิน แต่ประวัติต้องล็อกอิน → cron ทุก 15 นาที แบ่ง 200 โรงงาน/รอบ (cursor.offset) ให้ครบทุกชั่วโมง
 *   ประหยัดที่: observations เก็บเฉพาะจุดวัดน้ำ (typeName ≠ CEMS) · CEMS เก็บใน latest_observations อย่างเดียว
 */
async function diw_poms(ctx: Ctx): Promise<HandlerResult> {
  const base = String(ctx.source.url).replace(/\/$/, "");
  const SLICE = Number((ctx.source.meta as Json)?.slice ?? 200);
  const okData = (j: unknown) => { const o = j as Json; if (o?.code !== "SUCCESS") throw new Error("POMS ตอบ " + JSON.stringify(o).slice(0, 120)); return o.data as Json; };

  // 1) รายชื่อโรงงานทั้งหมด (17 หน้า) — ดึงทุกรอบเพราะเบา (~55 KB/หน้า) และเป็นแหล่งเดียวของพิกัด
  const first = okData(await fetchJson(`${base}/get/factory-list?page=1`));
  const maxPage = Number(first.maxPage ?? 1);
  const pages = await mapLimit(Array.from({ length: maxPage - 1 }, (_, i) => i + 2), 4, (p) => fetchJson(`${base}/get/factory-list?page=${p}`).then(okData));
  const factories = [first, ...pages].flatMap((d) => (d.items as Json[]) ?? []);
  const geomOf = (s: unknown) => { const m = String(s ?? "").match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/); return m ? { lng: +m[1], lat: +m[2] } : null; };
  const stRows: Json[] = [];
  for (const f of factories) {
    const g = geomOf(f.geom);
    if (!g || g.lat < 5 || g.lat > 21 || g.lng < 97 || g.lng > 106) continue;
    const addr = String(f.address ?? "");
    stRows.push({ ext_id: String(f.id), name_th: f.name ?? null, area_th: addr || null,
      province: addr.match(/จ\.\s*([^\s,]+)/)?.[1] ?? null, station_type: "factory_sensor", lat: g.lat, lng: g.lng,
      meta: { reg_no: f.no ?? null, reg_no_new: f.noNew ?? null, type: (f.type as Json)?.name ?? null, industry_type: (f.industryType as Json)?.name ?? null,
              colony: (f.colonyIndustry as Json)?.name ?? null, count_wpms: f.countOpms ?? 0, count_cems: f.countCems ?? 0, count_station: f.countStation ?? 0,
              severity_wpms: f.severityOpms ?? null, severity_cems: f.severityCems ?? null, logo: f.logo ?? null } });
  }
  const ids = await upsertStations(ctx, "diw_poms", stRows);

  // 2) ค่าล่าสุดของโรงงานในสไลซ์นี้
  const offset = Number(ctx.cursor?.offset ?? 0) % Math.max(stRows.length, 1);
  const slice = stRows.slice(offset, offset + SLICE);
  const obs: Json[] = [], latest: Json[] = [];
  let points = 0, errors = 0;
  await mapLimit(slice, 8, async (s) => {
    const id = ids.get(String(s.ext_id));
    if (!id) return;
    let d: Json;
    try { d = okData(await fetchJson(`${base}/get/measurement-list/${s.ext_id}`)); } catch { errors++; return; }
    const params = (d.parameters ?? {}) as Record<string, Json>;
    for (const m of Object.values((d.measurements ?? {}) as Record<string, Json>)) {
      const rec = String(m.recordedDate ?? "");
      const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rec) ? rec.replace(" ", "T").slice(0, 19) + "+07:00" : null;
      if (!at) continue;
      const type = String(m.typeName ?? "?"), code = String(m.code ?? m.id ?? "");
      const isWater = type !== "CEMS";
      points++;
      for (const [pid, pv] of Object.entries((m.parameters ?? {}) as Record<string, Json>)) {
        const p = params[pid]; if (!p || pv?.isVisible === false) continue;
        const v = num(pv.value), unit = String(p.unit ?? "").replace(/\\\//g, "/");
        const parameter = `${code}:${p.name}`;
        if (isWater) obs.push({ station_id: id, observed_at: at, parameter, value: v, unit, quality: v === null || pv.isError ? "missing" : "ok" });
        latest.push({ station_id: id, parameter, observed_at: at, value: v, unit,
          extra: { type, code, name: m.measName ?? null, severity: pv.severity ?? null, error: pv.isError ? (pv.errMsg ?? true) : null, channel: pv.channel ?? null } });
      }
    }
  });
  const n1 = await upsert(ctx, "observations", obs, "station_id,parameter,observed_at");
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  const next = offset + SLICE >= stRows.length ? 0 : offset + SLICE;
  return { rows: n1, cursor: { offset: next, total: stRows.length },
    note: `โรงงาน ${stRows.length} · รอบนี้ ${offset}-${offset + slice.length} · จุดวัด ${points} · ค่าน้ำ ${n1} · latest ${latest.length}${errors ? ` · ดึงไม่ได้ ${errors}` : ""}` };
}

/**
 * คพ. IWIS — สถานีตรวจวัดคุณภาพน้ำแหล่งน้ำผิวดินอัตโนมัติ (64 สถานี ทุก 30 นาที)
 *   api-iwis.pcd.go.th/mst-station-with-summary?limit=200 → result.data[] มี station_lat/lng + water_quality_summary_50 (50 รอบล่าสุด)
 *   observations เก็บเฉพาะรอบนาที :00 (รายชั่วโมง) ประหยัดที่ · latest เก็บทุกพารามิเตอร์พร้อม level/color ของ คพ.
 */
async function pcd_iwis(ctx: Ctx): Promise<HandlerResult> {
  const j = await fetchJson(String(ctx.source.url)) as Json;
  const data = ((j.result as Json)?.data ?? []) as Json[];
  if (data.length === 0) throw new Error("IWIS คืน data ว่าง: " + JSON.stringify(j).slice(0, 120));
  const UNITS = ((ctx.source.meta as Json)?.units ?? {}) as Record<string, string>;
  const stRows: Json[] = [];
  for (const s of data) {
    const lat = num(s.station_lat), lng = num(s.station_lng);
    if (lat === null || lng === null) continue;
    const ms = (s.mst_station ?? {}) as Json;
    stRows.push({ ext_id: String(ms.STATION_ID ?? s.station_code ?? s.station_name), name_th: s.station_name ?? null,
      area_th: [s.water_source_name, s.province_name && ("จ." + s.province_name)].filter(Boolean).join(" ") || null, province: s.province_name ?? null,
      station_type: "river_auto", lat, lng,
      meta: { station_code: s.station_code ?? null, place: ms.PLACE ?? null, water_source: s.water_source_name ?? null, main_basin: s.main_basin_name || null,
              region: s.region_name ?? null, station_uuid: ms.STATION_UUID ?? null, sub_basin_uuid: ms.SUB_BASIN_UUID ?? null } });
  }
  const ids = await upsertStations(ctx, "pcd_iwis", stRows);

  const obs: Json[] = [], latest: Json[] = [];
  const seenLatest = new Set<string>();
  for (const s of data) {
    const ms = (s.mst_station ?? {}) as Json;
    const id = ids.get(String(ms.STATION_ID ?? s.station_code ?? s.station_name));
    if (!id) continue;
    const rounds = [...((s.water_quality_summary ?? []) as Json[]), ...((s.water_quality_summary_50 ?? []) as Json[])]
      .filter((r) => r?.MEASURE_DATETIME).sort((a, b) => String(b.MEASURE_DATETIME).localeCompare(String(a.MEASURE_DATETIME)));
    for (const r of rounds) {
      const at = String(r.MEASURE_DATETIME);
      const hourly = /:00:00/.test(String(r.MEASURE_TIME ?? ""));
      for (const p of (((r.SUMMARY_JSON as Json)?.data ?? []) as Json[])) {
        const name = String(p.parameter ?? ""); if (!name) continue;
        const v = num(p.value), unit = UNITS[name] ?? "";
        const key = `${id}:${name}`;
        if (!seenLatest.has(key)) { seenLatest.add(key); latest.push({ station_id: id, parameter: name, observed_at: at, value: v, unit, extra: { level: p.level ?? null, color: p.color ?? null } }); }
        if (hourly && v !== null) obs.push({ station_id: id, observed_at: at, parameter: name, value: v, unit, quality: "ok" });
      }
    }
  }
  const n1 = await upsert(ctx, "observations", obs, "station_id,parameter,observed_at");
  await upsert(ctx, "latest_observations", latest, "station_id,parameter");
  const fresh = data.filter((s) => (s.measure_date ?? "") !== "ไม่ระบุ").length;
  return { rows: n1, note: `สถานี ${stRows.length} (ส่งค่าล่าสุด ${fresh}) · ค่ารายชั่วโมง ${n1} · latest ${latest.length}` };
}

async function not_ready(_ctx: Ctx): Promise<HandlerResult> {
  throw new Error("handler นี้อยู่ในเฟสถัดไป (ต้องมี api key) — ดู docs/แหล่งข้อมูลราชการ.md");
}

const HANDLERS: Record<string, (c: Ctx) => Promise<HandlerResult>> = {
  air4thai, gistda_pm25, gistda_hotspot, tmd_quake, dgr_wells, royalrain, gistda_flood, pcd_dspot, diw_poms, pcd_iwis,
  tmd_today: tmd_obs, tmd_3h: tmd_obs,
  firms: not_ready, tmd_nwp: not_ready,
};

// ─────────────────────────────────────────────────────────── พยากรณ์ ณ จุด (TMD NWP) — เรียกจากเบราว์เซอร์

/**
 * action "forecast": พยากรณ์อากาศ ณ พิกัดจาก TMD NWP API (กริด 2 กม. รายชั่วโมง 48 ชม. + รายวัน 7 วัน)
 *   - เปิดให้เบราว์เซอร์เรียกโดยไม่ต้องมี cron token (token ของ TMD อยู่ใน Secrets เท่านั้น)
 *   - แคช 1 ชั่วโมงต่อพิกัดปัด 2 ตำแหน่ง (~1 กม.) ใน api_cache — TMD นับ datapoint และมี rate limit (429)
 *   - โครง JSON ที่ TMD คืน (ตรวจ 3 ก.ย. 2569): {WeatherForecasts:[{location:{lat,lon}, forecasts:[{time, data:{tc,rh,rain,ws10m,wd10m,cond}}]}]}
 */
const TMD_COND: Record<number, string> = {
  1: "ท้องฟ้าแจ่มใส", 2: "มีเมฆบางส่วน", 3: "เมฆเป็นส่วนมาก", 4: "มีเมฆมาก", 5: "ฝนตกเล็กน้อย", 6: "ฝนปานกลาง",
  7: "ฝนตกหนัก", 8: "ฝนฟ้าคะนอง", 9: "อากาศหนาวจัด", 10: "อากาศหนาว", 11: "อากาศเย็น", 12: "อากาศร้อนจัด",
};

async function forecastAt(sb: SupabaseClient, lat: number, lng: number): Promise<Json> {
  const key = `tmd_nwp:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const { data: hit } = await sb.from("api_cache").select("payload, fetched_at").eq("cache_key", key).maybeSingle();
  if (hit && Date.now() - new Date(hit.fetched_at).getTime() < 3600e3) return { ...(hit.payload as Json), cached: true, fetched_at: hit.fetched_at };

  const tok = Deno.env.get("TMD_NWP_TOKEN");
  if (!tok) throw new Error("ยังไม่ได้ตั้ง Secret TMD_NWP_TOKEN");
  const bkk = new Date(Date.now() + 7 * 3600e3);                      // เวลาไทย
  const date = bkk.toISOString().slice(0, 10), hour = bkk.getUTCHours();
  const H = { "accept": "application/json", "authorization": "Bearer " + tok };
  const base = "https://data.tmd.go.th/nwpapi/v1/forecast/location";
  const [h, d] = await Promise.all([
    fetch(`${base}/hourly/at?lat=${lat}&lon=${lng}&fields=tc,rh,rain,ws10m,wd10m,cond,slp&date=${date}&hour=${hour}&duration=24`, { headers: H }),
    fetch(`${base}/daily/at?lat=${lat}&lon=${lng}&fields=tc_max,tc_min,rh,rain,cond&date=${date}&duration=7`, { headers: H }),
  ]);
  if (!h.ok || !d.ok) throw new Error(`TMD NWP HTTP hourly=${h.status} daily=${d.status}${h.status === 429 || d.status === 429 ? " (เกิน rate limit)" : ""}`);
  const hj = await h.json() as Json, dj = await d.json() as Json;
  const wf = (j: Json) => ((j.WeatherForecasts as Json[]) ?? [])[0] ?? {};
  const label = (rows: Json[]) => rows.map((r) => ({ time: r.time, ...(r.data as Json), cond_th: TMD_COND[Number((r.data as Json)?.cond)] ?? null }));
  const payload: Json = {
    source: "กรมอุตุนิยมวิทยา NWP API (กริด 2 กม.)",
    grid: (wf(hj).location as Json) ?? null,
    hourly: label((wf(hj).forecasts as Json[]) ?? []),
    daily: label((wf(dj).forecasts as Json[]) ?? []),
  };
  await sb.from("api_cache").upsert({ cache_key: key, source_id: "tmd_nwp", payload, fetched_at: new Date().toISOString() });
  return { ...payload, cached: false, fetched_at: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────── ตัวหลัก

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST เท่านั้น", version: VERSION }, 405);

  let body: Json = {};
  try { body = await req.json(); } catch { /* ว่างได้ */ }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // action สาธารณะ (ไม่ต้องมี cron token) — พยากรณ์ / รอยไหม้ ณ จุด (key ของหน่วยงานอยู่ฝั่งนี้ แคชกัน rate limit)
  if (body.action === "forecast" || body.action === "burnscar") {
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!(lat >= 5 && lat <= 21 && lng >= 97 && lng <= 106)) return json({ ok: false, error: "พิกัดอยู่นอกประเทศไทย" }, 400);
    try {
      const r = body.action === "forecast" ? await forecastAt(sb, lat, lng) : await burnScarAt(sb, lat, lng);
      return json({ ok: true, version: VERSION, ...r });
    } catch (e) { return json({ ok: false, error: (e as Error).message }, 502); }
  }

  const token = Deno.env.get("ENVI_CRON_TOKEN");
  const auth = req.headers.get("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) return json({ ok: false, error: "token ไม่ถูกต้อง" }, 401);

  const sourceId = String(body.source ?? "");
  const dry = body.dry === true;

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
