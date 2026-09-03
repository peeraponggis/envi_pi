# ขั้นตอนติดตั้ง envi_pi บน Supabase (โปรเจกต์ใหม่ แยกจาก pi-boq-dev)

ไม่ต้องใช้ Supabase CLI — ทุกอย่างทำผ่าน Dashboard · ทำตามลำดับ ห้ามสลับ
เครื่องหมาย ☐ ให้ติ๊กเมื่อทำแล้ว

## 0. สร้างโปรเจกต์

- ☐ Dashboard → New project → ชื่อ `envi-pi` · region Singapore · ตั้ง DB password แล้ว**เก็บไว้ในที่ปลอดภัย** (ไม่ต้องบอกใคร ไม่ต้องใส่ไฟล์ไหน)
- ☐ Project Settings → Data API → คัดลอก **Project URL** และ **publishable (anon) key**
- ☐ วางลง `web/js/config.js` สองบรรทัดบน (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`)
  — ค่านี้เปิดเผยได้ ติดไปกับทุก request อยู่แล้ว สิ่งที่กันข้อมูลคือ RLS

## 1. ฐานข้อมูล (SQL Editor — วางทีละไฟล์ กด Run ดูผลตารางท้ายไฟล์ทุกครั้ง)

ลำดับ | ไฟล์ | ผลที่ต้องเห็น
---|---|---
☐ 1 | `supabase/migrations/20260903000100_schema.sql` | 12 ตาราง "มี = true" · extension postgis/pg_cron/pg_net = true (ถ้า pg_cron ล้ม → Database → Extensions เปิด `pg_cron` และ `pg_net` ก่อนแล้วรันซ้ำ)
☐ 2 | `supabase/migrations/20260903000200_rls.sql` | notice "RLS เรียบร้อยครบ 12 ตาราง" + ตาราง policies
☐ 3 | `supabase/migrations/20260903000300_rpc.sql` | site_report / nearest_stations / layer_features_bbox → anon = true
☐ 4 | `supabase/migrations/20260903000400_seed_sources.sql` | ตารางนับแหล่งตามหมวด (~33 แหล่ง)
☐ 5 | `supabase/migrations/20260903000600_import.sql` | import_* → authenticated = true, anon = false
☐ 6 | `supabase/เปิดสิทธิ์ Data API.sql` | notice "เรียบร้อย — anon อ่านข้อมูลราชการได้…" ถ้าเห็น **แดง** ให้อ่านข้อความ อย่ารันไฟล์ถัดไป
☐ 7 | `supabase/ตรวจสภาพ.sql` | ตาราง 1 ทุกแถว RLS=true · ไม่มี exception

ทดสอบจากเบราว์เซอร์: `node scripts/serve.mjs` → เปิด `http://127.0.0.1:5500/web/index.html` → ต้องเห็นแผนที่ ไม่มีแถบเตือน "ยังไม่ได้ตั้งค่า config.js" · กด "วิเคราะห์จุดนี้" ได้รายงาน (ทุกหมวดว่างได้ เพราะยังไม่ดึงข้อมูล) — ถ้าได้ `42501` แปลว่าข้อ 6 ยังไม่ผ่าน

## 2. ผู้ใช้

- ☐ Authentication → Users → Add user → อีเมล/รหัสผ่าน · ติ๊ก **Auto Confirm**
- ☐ SQL Editor: `update public.profiles set role = 'admin' where email = '<อีเมล>'; select email, role from public.profiles;`
  — ต้องเห็นแถวนั้น role=admin จริง ๆ (ถ้า select ว่างแปลว่า trigger ยังไม่ทำงาน ให้รันไฟล์ 1 ซ้ำ)
- ☐ หน้าเว็บ → เข้าสู่ระบบ → มุมบนซ้ายขึ้นอีเมล (admin) และมีลิงก์ "นำเข้าไฟล์"

## 3. Edge Function `envi-ingest`

- ☐ Edge Functions → Deploy a new function → **via Editor** → ชื่อ `envi-ingest` → วางไฟล์ `supabase/functions/envi-ingest/index.ts` ทั้งไฟล์ → Deploy
- ☐ ที่ฟังก์ชัน → Details/Settings → **Verify JWT = ปิด** (เราตรวจ token เองใน header)
- ☐ Edge Functions → Secrets → เพิ่ม
  - `ENVI_CRON_TOKEN` = สุ่มยาว ≥ 32 ตัว (เช่นจาก `openssl rand -hex 32` หรือเว็บสุ่มรหัสผ่าน)
  - (เฟส 4) `TMD_UID`, `TMD_UKEY` · (เฟส 5) `GISTDA_API_KEY`, `FIRMS_MAP_KEY`, `TMD_NWP_TOKEN`
- ☐ ทดสอบ: ที่ฟังก์ชัน → Invoke (หรือ curl) · Headers: `Authorization: Bearer <ENVI_CRON_TOKEN>` · Body:

```json
{"source":"air4thai","dry":true}
```

  ต้องได้ `{"ok":true,"rows":<ประมาณ 1400>,…}` · เอา `"dry"` ออกแล้ว Invoke อีกครั้ง → ไป SQL Editor:

```sql
select * from public.ingest_runs order by started_at desc limit 5;
select count(*) from public.stations where source_id = 'air4thai';
select public.site_report(13.75, 100.5)->'air';
```

- ☐ ทำแบบเดียวกันกับ `tmd_quake`, `gistda_hotspot_modis`, `gistda_hotspot_viirs`, `gistda_pm25`, `royalrain`
  (แหล่งที่ล้มให้ดู `ingest_runs.error` — endpoint ราชการเปลี่ยนได้ ให้แก้ handler ใน index.ts แล้ว deploy ใหม่)
- ☐ รีเฟรชหน้าเว็บ → จุดสถานีสีตาม AQI ปรากฏ · แท็บภัยพิบัติมีจุดความร้อน/แผ่นดินไหว

## 4. ตั้งเวลาอัตโนมัติ (pg_cron)

- ☐ SQL Editor รัน **ครั้งเดียว** (แทนค่าจริง อย่าบันทึกลงไฟล์):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/envi-ingest', 'envi_ingest_url');
select vault.create_secret('<ENVI_CRON_TOKEN ตัวเดียวกับใน Secrets>', 'envi_cron_token');
```

- ☐ รัน `supabase/migrations/20260903000500_cron.sql` → ต้องได้ cron jobs envi_* = 11
- ☐ เปิดทีละแหล่งที่ทดสอบผ่านแล้ว:

```sql
update public.sources set cron_enabled = true where id in ('air4thai','tmd_quake','gistda_hotspot_modis','gistda_hotspot_viirs','gistda_pm25','royalrain');
```

- ☐ รอ 1 ชั่วโมงแล้วดู `select * from public.ingest_runs order by started_at desc limit 10;` และ `select * from cron.job_run_details order by start_time desc limit 10;`

## 5. นำเข้าไฟล์นิ่ง (เฟส 2-3)

1. ดาวน์โหลด SHP จากหน่วยงาน (ลิงก์ใน `docs/แหล่งข้อมูลราชการ.md`)
2. แปลงบนเครื่อง (ไม่ต้องติดตั้งอะไร):

```bash
npx mapshaper -i reserve_forest.shp encoding=utf8 -proj wgs84 -o reserve_forest.geojson
```

   ไฟล์ใหญ่มาก (landuse) ให้ตัดเฉพาะจังหวัดหรือ `-simplify 10% keep-shapes` **ยกเว้น LDD (CC BY-NC-ND ห้าม simplify)**
3. เปิด `web/import.html` (ล็อกอิน admin/editor) → เลือกไฟล์ → นำเข้า → อ่านบันทึกว่าเข้ากี่แถว ข้ามกี่แถว
4. `select id, feature_count, loaded_at from public.layers;` แล้วลองวิเคราะห์จุดในป่า → หมวดป่าไม้ต้องขึ้นชื่อชั้น

## 6. เมื่อแก้โค้ด

- SQL: แก้ไฟล์ใน `supabase/` แล้วรันซ้ำได้เลย (idempotent ทุกไฟล์)
- Edge Function: แก้ `supabase/functions/envi-ingest/index.ts` → เพิ่ม `VERSION` → วางทับใน Dashboard → Deploy · `ingest_runs.fn_version` จะบอกว่ารุ่นไหนรันอยู่
- หน้าเว็บ: `node --test test/*.test.mjs` ต้องผ่านก่อน push

## สิ่งที่ทำไปแล้วจริง (3 ก.ย. 2569)

ข้อ 0-5 ทำครบแล้วบนโปรเจกต์ `mplexdeaqgrdoqqhypqb` (Org `envi-pi`, Free) · Edge Function v1.0.1 · cron เปิด 7 แหล่ง · admin 1 คน
ข้อ 5 นำเข้าแล้ว: ป่าสงวนแห่งชาติ 1,221 แปลง · ดินถล่ม 56,177 จุด · ศูนย์กลางตำบล 7,364 — ทำผ่าน session admin ในเบราว์เซอร์ (fetch GeoJSON/JSON จาก dev server แล้วเรียก RPC import_* ทีละชุด) ไม่ได้ใช้ปุ่มเลือกไฟล์ใน import.html
ชั้น DWR (ลุ่มน้ำหลัก/สาขา จังหวัด/อำเภอ แรมซาร์ เขื่อน สถานีอุทกฯ) นำเข้าแล้วจาก `gis.dwr.go.th/arcgis/rest/services` ด้วย `node scripts/fetch_arcgis.mjs <layer-url> <out.geojson>` → `npx mapshaper -simplify interval=15 keep-shapes` → RPC `import_features` (ไม่ต้องใช้หน้า downloads)
เฟส 4 สภาพอากาศ: Secret `TMD_NWP_TOKEN` ตั้งแล้ว (JWT จาก data.tmd.go.th/nwpapi หมดอายุ ก.ย. 2570 — ต่ออายุแล้วอัปเดต Secret) · Edge v1.1.0 action `forecast`
เฟส 5 GISTDA: Secret `GISTDA_API_KEY` ตั้งแล้ว · migration 800 (`replace_layer_features`) รันแล้ว · cron `envi_gistda_flood` ทุก 6 ชม. (เปิดแล้ว) · Edge v1.2.0 action `burnscar`
ตำบลโพลิกอน DWR (`dwr_tambon` 7,639 แปลง, GeoJSON ย่อแล้ว 51 MB) นำเข้าแล้ว 3 ก.ย. 69 — ใช้เวลาประมาณ 1 นาทีผ่าน RPC ชุดละ ≤150 แปลง/1.5 MB
แผนที่รังสีอาทิตย์ พพ. (`dede_solar` 7,416 ตำบล จาก `data/raw/dede_solar_2560.xlsx` → `dede_solar_rows.json` → RPC `import_stations`) นำเข้าแล้ว 3 ก.ย. 69
โรงงาน กรมโรงงานฯ 68,116 แห่ง (`data/raw/diw_*.csv` → `diw_events_rows.json` ผูกพิกัดศูนย์กลางตำบล → RPC `import_events` source `diw_factory` kind other) นำเข้าแล้ว 3 ก.ย. 69 · migration 900 (`site_report` เพิ่ม factories_5km / eia_20km) รันแล้ว
EIA สผ. นำเข้าแล้ว 3 ก.ย. 69 (13,350 โครงการ): `node scripts/scrape_eia.mjs list` → `node scripts/scrape_eia.mjs detail` (~45 นาที รันซ้ำได้ เขียนต่อจากที่มี) → `node scripts/build_eia_rows.mjs` → RPC `import_events` source `onep_eia` kind other · อัปเดตครั้งถัดไปทำ 3 ขั้นเดิม (detail ดึงเฉพาะ id ใหม่)
**ยังค้าง**: การใช้ที่ดิน LDD รายจังหวัด · TMD API ชุดเก่า uid/ukey (สถานีตรวจวัดจริง) ถ้าต้องการ · NASA FIRMS MAP_KEY (สำรอง)

⚠️ บทเรียน deploy Edge Function ผ่าน Dashboard: ถ้า deploy ล้มด้วย "Failed to bundle … could not be parsed" ให้หาคอมเมนต์ที่มีลำดับ slash-star-slash (เช่นเขียน path ที่มี `*` คั่นด้วย `/`) — bundler อ่านเป็นปิดคอมเมนต์ ทั้งที่ `node --check` ผ่าน

สิ่งที่เจอตอนทำจริงและแก้ไปแล้ว (ถ้าทำซ้ำในโปรเจกต์ใหม่จะเจออีก):
- ไฟล์ 3 รุ่นแรก anon ยังเรียก `purge_old_observations()` ได้ → แก้ให้ revoke จาก anon/authenticated ด้วย (ไฟล์ปัจจุบันถูกแล้ว)
- Air4Thai ใช้ใบรับรอง Let's Encrypt YR1 แต่ส่ง chain ผิด → Edge Function ฝัง CA ไว้แล้ว (หมดอายุ 2 ก.ย. 2571 — ก่อนถึงให้โหลดใหม่จาก `http://yr1.i.lencr.org/` หรือ intermediate ตัวใหม่ตาม AIA ของ leaf)
- GISTDA hotspot ไม่รองรับ pagination · DGR คืน N×1000 แถวต่อหน้า → handler ปัจจุบันรองรับแล้ว
- ช่อง Secrets และสวิตช์ Verify JWT ใน Dashboard ไม่รับการพิมพ์/คลิกจากเครื่องมืออัตโนมัติ ต้องทำด้วยมือหรือ set ค่าผ่าน JS

## ปัญหาที่พบบ่อย

อาการ | สาเหตุ | แก้
---|---|---
`42501 permission denied` ทั้งที่ RLS ถูก | ยังไม่รัน "เปิดสิทธิ์ Data API.sql" | รันไฟล์ข้อ 6
`function st_makepoint does not exist` | PostGIS อยู่ schema extensions | ไฟล์ 1 ใช้ `extensions.` ครบแล้ว — ถ้าเขียน SQL เพิ่มเอง ให้ `set search_path = public, extensions`
Invoke ได้ 401 | token ไม่ตรง / Verify JWT ยังเปิด | ตรวจ Secrets + ปิด Verify JWT
ingest_runs.error "HTTP 5xx" | เซิร์ฟเวอร์ราชการล่มชั่วคราว | ปล่อยให้ cron รอบถัดไปลองใหม่
cron รันแต่ไม่มีอะไรเกิด | `cron_enabled=false` หรือ Vault ยังไม่มี secret | ดูตาราง 4 ใน ตรวจสภาพ.sql
หน้าเว็บขึ้น "ยังไม่ได้ตั้งค่า config.js" | placeholder ยังอยู่ | ข้อ 0
