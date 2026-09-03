/**
 * ค่าตั้งค่าการเชื่อมต่อ — envi_pi (โปรเจกต์ Supabase แยกจาก pi-boq-dev)
 *
 * สองค่าแรก "เปิดเผยได้" โดยการออกแบบ — ติดไปกับทุก request ที่เบราว์เซอร์ยิงอยู่แล้ว
 * สิ่งที่กันข้อมูลจริง ๆ คือ RLS ในฐานข้อมูล ไม่ใช่การซ่อนคีย์นี้
 *
 * ⚠️ ห้ามใส่ secret key (sb_secret_… / service_role) หรือ token ของ cron ในไฟล์นี้เด็ดขาด
 *
 * วิธีตั้ง: Dashboard → Project Settings → API (หรือ Data API) → คัดลอก Project URL
 * และ publishable (anon) key มาแทน placeholder สองบรรทัดล่าง
 */

export const SUPABASE_URL = 'https://mplexdeaqgrdoqqhypqb.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_37XstkQZCE8DA1odPgQNzw_-jtBiX_h';

/** คีย์เก็บ session — ตั้งชื่อไม่ให้ชนกับ pi_system_auth ของ CRM-Pi ที่อาจอยู่ origin เดียวกัน */
export const AUTH_STORAGE_KEY = 'envi_pi_auth';

/** แคชผล API ต่างประเทศ (NASA POWER / PVGIS) กี่วันก่อนเรียกใหม่ */
export const CACHE_TTL_DAYS = 30;

/** พิกัดเริ่มต้น (สืบทอดจากไฟล์ V2.9.0) */
export const DEFAULT_LAT = 14.018951678746875;
export const DEFAULT_LNG = 100.55772755582095;

/** แท็บหมวด — ลำดับตามที่ผู้ใช้เลือกทำก่อน (3 ก.ย. 2569) */
export const CATEGORIES = [
  { key: 'air',        label: '🌫️ คุณภาพอากาศ', phase: 1 },
  { key: 'disaster',   label: '🔥 ภัยพิบัติ',     phase: 1 },
  { key: 'water',      label: '💧 น้ำ/ธรณี',      phase: 2 },
  { key: 'forest',     label: '🌳 ป่าไม้/ที่ดิน',  phase: 3 },
  { key: 'eia',        label: '🏭 EIA/โรงงาน',    phase: 3 },
  { key: 'vegetation', label: '🌿 พืชพรรณ',       phase: 1 },
  { key: 'solar',      label: '☀️ แสงอาทิตย์',    phase: 4 },
  { key: 'weather',    label: '🌦️ สภาพอากาศ',    phase: 4 },
];

/** ชั้น tile ที่ซ้อนสด (ไม่ผ่าน DB) */
export const TILE_LAYERS = {
  esri: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  gibs_ndvi: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png',
  gistda_aq: 'https://gistdaportal.gistda.or.th/data/rest/services/FR_Fire/AirQuality_hourly/MapServer/tile/{z}/{y}/{x}',
};

/** ระดับ AQI ตามเกณฑ์กรมควบคุมมลพิษ (color_id 1-5) */
export const AQI_LEVELS = [
  { max: 25,       label: 'ดีมาก',                  color: '#3BB3F0' },
  { max: 50,       label: 'ดี',                     color: '#7FD24B' },
  { max: 100,      label: 'ปานกลาง',                color: '#FFE45C' },
  { max: 200,      label: 'เริ่มมีผลกระทบต่อสุขภาพ', color: '#FFA24C' },
  { max: Infinity, label: 'มีผลกระทบต่อสุขภาพ',      color: '#FF4B4B' },
];

/** ระดับ PM2.5 (µg/m³ เฉลี่ย 24 ชม.) เกณฑ์ใหม่ 2566 */
export const PM25_LEVELS = [
  { max: 15,       label: 'ดีมาก',                  color: '#3BB3F0' },
  { max: 25,       label: 'ดี',                     color: '#7FD24B' },
  { max: 37.5,     label: 'ปานกลาง',                color: '#FFE45C' },
  { max: 75,       label: 'เริ่มมีผลกระทบต่อสุขภาพ', color: '#FFA24C' },
  { max: Infinity, label: 'มีผลกระทบต่อสุขภาพ',      color: '#FF4B4B' },
];
