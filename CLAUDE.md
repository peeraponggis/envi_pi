# envi_pi — Memory สำหรับ Claude Code

ระบบนำเสนอข้อมูลผลกระทบด้านสิ่งแวดล้อมประเทศไทย ดึงจากหน่วยราชการ · repo `https://github.com/peeraponggis/envi_pi`
แผนฉบับเต็ม: `docs/แผนระบบ.md` · แหล่งข้อมูล: `docs/แหล่งข้อมูลราชการ.md` · ติดตั้ง: `docs/ขั้นตอนติดตั้ง Supabase.md`

## สถาปัตยกรรม (ตัดสินใจแล้ว 3 ก.ย. 2569 — อย่าเปลี่ยนโดยไม่ถามผู้ใช้)
- **โปรเจกต์ Supabase แยกต่างหาก** จาก `pi-boq-dev` ของ CRM — ไม่ใช้ profiles/ตาราง/FK ร่วมกัน · ใช้ schema `public`
- หน้าเว็บ **plain HTML + CDN ES module ไม่มี build** อยู่ใน `web/` · ไคลเอนต์ Supabase **ตัวเดียว** (cache Promise ใน `envi-core.js`)
- ดึงข้อมูลราชการด้วย **pg_cron → Edge Function `envi-ingest`** (วางโค้ดใน Dashboard editor เพราะเครื่องไม่มี CLI)
  สำเนาหลักอยู่ `supabase/functions/envi-ingest/index.ts` — แก้ที่นี่ก่อนเสมอ แล้วเพิ่ม `VERSION`
- **PostGIS** เปิดใน schema `extensions` → SQL ที่แตะ geom ต้อง `extensions.ST_xxx` หรือ `set search_path = public, extensions`
- **anon อ่านข้อมูลราชการได้** (เว็บสาธารณะ) · ล็อกอินเพื่อบันทึกผล/นำเข้าไฟล์ · เปลี่ยนได้โดยลบบล็อก anon ใน `20260903000200_rls.sql`
- API ต่างประเทศ (NASA POWER, PVGIS, Nominatim, GIBS) เรียกสดจากเบราว์เซอร์ + แคช `api_cache` · API ไทยผ่าน DB เท่านั้น (HTTP-only/CORS)
- Secrets (ENVI_CRON_TOKEN, TMD_UID/UKEY, GISTDA_API_KEY, FIRMS_MAP_KEY) อยู่ใน Edge Secrets + Vault เท่านั้น **ห้ามเขียนลงไฟล์**
- `web/js/config.js` มีแค่ URL + publishable key (เปิดเผยได้) — ค่าเริ่มต้นเป็น placeholder ผู้ใช้กรอกเอง

## โครงไฟล์
- `supabase/migrations/…_schema.sql` (1) · `…_rls.sql` (2) · `…_rpc.sql` (3) · `…_seed_sources.sql` (4) · `…_cron.sql` (5, รันหลังตั้ง Vault) · `…_import.sql` (6)
- `supabase/เปิดสิทธิ์ Data API.sql` (รันหลัง 1-3) · `supabase/ตรวจสภาพ.sql` (แสดงทุกแถว raise เฉพาะเรื่องใช้งานไม่ได้)
- `web/js/envi-core.js` ไม่แตะ DOM (ทดสอบ `node --test test/*.test.mjs`) · `web/js/app.js` ที่เดียวที่แตะ DOM/Cesium · `web/js/import.js` หน้า admin
- `web/css/pi.css` คัดลอกจาก pi_crm_erp (ธีมเขียว Sarabun) · `web/css/envi.css` override เฉพาะแผนที่ — ห้ามนิยามสีใหม่นอกตัวแปร
- ไฟล์ต้นฉบับ `solar energy potential based on satellite data V2.9.0.html` เก็บไว้เป็นอ้างอิง ไม่แก้

## กติกา SQL (ยกมาจาก pi_crm_erp)
1. รันซ้ำได้ทุกไฟล์ · 2. ทุกตารางเปิด RLS · 3. สคริปต์ grant ห้ามครอบ begin/commit ดัก error รายตาราง `raise exception` ตอนท้าย
4. revoke execute จาก **public** ก่อน grant ฟังก์ชัน (anon ได้สิทธิ์ผ่าน PUBLIC) · 5. ตรวจผลต้องแสดงทุกแถว ห้ามกรองด้วยค่าที่อาจไม่มี
6. งานหลายขยักรายงานว่าขยักไหนผ่าน (import_* คืน inserted/skipped/errors)

## กติกาข้อมูลราชการ
- ค่าเป็น string + sentinel (-1, -999, "", "-") → `num()` คืน null ห้ามเก็บ -999 ลง `value`
- วันที่ พ.ศ. → ลบ 543 เมื่อปี > 2400 · เวลาไทยไม่มี TZ → ต่อ +07:00 (`parseThaiDate` / `thaiDateTimeToISO`)
- ห้ามใช้ `new Date().toISOString().slice(0,10)` เป็นวันนี้ — ใช้ `todayISO()`
- ArcGIS 1000 แถว/คำขอ วน `resultOffset` · DGR 117k แถว ใช้ `ingest_runs.cursor`
- handler ต้อง fail-soft: บันทึก `ingest_runs.error` ไม่ throw ให้ cron ค้าง
- LDD landuse = CC BY-NC-ND ห้าม simplify · HII = CC BY-NC · แสดงเครดิตทุกแหล่ง (แถบล่างขวาแผนที่อ่านจาก `sources.agency`)
- endpoint ราชการส่วนใหญ่ **ไม่มีเอกสาร** (Air4Thai, GISTDA PM2.5, Royal Rain) — เปลี่ยนได้ทุกเมื่อ อย่าเชื่อโครงสร้างจากความจำ ให้ดู `ingest_runs.error`

## สถานะ (3 ก.ย. 2569 — ติดตั้งจริงแล้ว)
- ✅ โปรเจกต์ Supabase `envi-pi` ref `mplexdeaqgrdoqqhypqb` (Org ใหม่ `envi-pi` แผน Free, บัญชี Gmail แยกของผู้ใช้) — SQL ทั้ง 7 ไฟล์รันผ่าน · Vault มี `envi_ingest_url` + `envi_cron_token`
- ✅ Edge Function `envi-ingest` v1.0.1 deploy แล้ว (Verify JWT ปิด · Secret `ENVI_CRON_TOKEN` ตั้งแล้ว) · cron 11 job · `cron_enabled=true` 7 แหล่ง: air4thai, tmd_quake, gistda_hotspot_modis/viirs, gistda_pm25, royalrain_radar, dgr_wells
- ✅ ข้อมูลจริงเข้าแล้ว: สถานี Air4Thai 173 · hotspot 1,533 · แผ่นดินไหว 10 · PM2.5 ดาวเทียม 77 จังหวัด · เรดาร์ 9 · บ่อบาดาลกำลังทยอย (cursor)
- ✅ ผู้ใช้ admin: `wisemenow9@gmail.com` (สร้าง 3 ก.ย. 69)
- ✅ เฟส 2-3 นำเข้าแล้ว (3 ก.ย. 69, ผ่าน RPC import_* ด้วย session admin ในเบราว์เซอร์): ป่าสงวนแห่งชาติ 1,221 แปลง (layer `rfd_reserve_forest`, simplify 15 m) · ดินถล่ม DMR 56,177 จุด (events, `YEAR_DATA` ว่างทั้งหมด → occurred_at = 1970-01-01) · ศูนย์กลางตำบล 7,364 (stations `dopa_tambon`)
  ไฟล์ดิบ+GeoJSON อยู่ `data/raw/` (gitignore) · SHP ทั้งสองเป็น UTM zone 47 WGS84 มาใน .rar (แตกด้วย WinRAR ที่ `C:\Program Files\WinRAR\UnRAR.exe`)
- ✅ **DWR ArcGIS REST** (`https://gis.dwr.go.th/arcgis/rest/services` เปิดสาธารณะ 27 ชั้น — พบจากหน้า webgis.dwr.go.th/projects ที่เปิด web map ของ ArcGIS Enterprise) ดึงด้วย `scripts/fetch_arcgis.mjs` แล้วนำเข้าแล้ว (3 ก.ย. 69 บ่าย):
  ลุ่มน้ำหลัก 28 (`dwr_main_basin`) · ลุ่มน้ำสาขา 359 (`dwr_sub_basin`) · จังหวัด 77 (`dwr_province`) · อำเภอ 883 (`dwr_amphoe`) · แรมซาร์ 113 (`onep_ramsar`) · เขื่อน 1,087 (stations `dwr_dam`) · สถานีอุทกวิทยา 126 (`dwr_hyd_station`)
  ชั้นที่ยังไม่ดึง: Tambon 7,640 โพลิกอน · WELL 72,658 · NAT_WTR_BODY 28,394 · 25_BASIN · พื้นที่ชุ่มน้ำท้องถิ่น 36,408 จุด · ประสิทธิภาพการระบายน้ำ (เส้น)
- ✅ **ตารางดัชนี `layer_features_idx`** (ST_Subdivide 256 จุดยอด, migration 700) — site_report ใช้ตารางนี้ทำ point-in-polygon; ก่อนมีดัชนี โพลิกอนลุ่มน้ำหลัก/แรมซาร์ทำให้ 57014 statement timeout · trigger เติมดัชนีเองเมื่อ import · ถ้าดัชนีเพี้ยนรัน `select * from rebuild_layer_index(null)`
- ✅ **เฟส 4 สภาพอากาศ (3 ก.ย. 69 เย็น)**: TMD **NWP API** (JWT ผู้ใช้สมัครเอง หมดอายุ ก.ย. 2570) เก็บเป็น Secret `TMD_NWP_TOKEN` · Edge `envi-ingest` v1.1.0 มี action สาธารณะ `{"action":"forecast","lat","lng"}` (ไม่ต้องมี cron token, CORS เปิด) แคช 1 ชม./พิกัดปัด 2 ตำแหน่งใน `api_cache` · แท็บสภาพอากาศแสดง 24 ชม. + 7 วัน
  ⚠️ ผู้ใช้ **ไม่ได้สมัคร TMD API ชุดเก่า (uid/ukey)** — handler `tmd_today`/`tmd_3h` (สถานีตรวจวัดจริง 122 สถานี) ยังรันไม่ได้ ถ้าต้องการต้องสมัครแยกที่ data.tmd.go.th/api
  ⚠️ token JWT ของ TMD ถูกวางในแชตตอนส่งให้ — ถ้ากังวลให้ revoke แล้วออกใหม่ที่ data.tmd.go.th/nwpapi แล้วอัปเดต Secret
- ✅ **เฟส 5 GISTDA api-gateway (3 ก.ย. 69 ค่ำ)**: Secret `GISTDA_API_KEY` (key ส่งเป็น `?api_key=` หรือ header `API-Key`) · Edge v1.2.0
  - handler `gistda_flood` (cron ทุก 6 ชม. เปิดแล้ว): STAC `flood/collections/flood1day_r2/items` → assets.data GeoJSON → RPC `replace_layer_features('gistda_flood_1d')` (migration 800, service_role เท่านั้น) · วันไม่มีน้ำท่วม = 0 โพลิกอน · flood3/7/30day ไม่มี item · gi-service flood-recurrence 404 ทุกเวอร์ชัน
  - action สาธารณะ `burnscar` {lat,lng}: `resources/features/burn-scar?bbox=±0.045°` (79,435 โพลิกอนทั้งประเทศ ไม่ควรนำเข้า) แคช 24 ชม. → แท็บภัยพิบัติแสดงจำนวน/ไร่/ชนิดที่ดิน + วาดโพลิกอนสีส้มด้วย GeoJsonDataSource
  - WMS flood-freq มี (Vallaris) แต่ต้องแนบ key ใน URL → ไม่ซ้อนในเบราว์เซอร์ (key จะหลุด) ถ้าจะใช้ต้อง proxy tile ผ่าน Edge
  - 🐛 แก้ไปด้วย: cron job เรดาร์เรียก `'royalrain'` แต่ id จริง `'royalrain_radar'` (ไม่เคยยิง) · คอมเมนต์ที่มี slash-star-slash ทำ bundler ของ Supabase พังตอน deploy
- ⬜ ยังไม่ได้นำเข้า: การใช้ที่ดิน LDD รายจังหวัด · EIA/โรงงาน CSV · ชั้นคุณภาพลุ่มน้ำ (ไม่มีบน ArcGIS ของ DWR) · DEDE รังสีอาทิตย์ 38 สถานี (XLSX) · Tambon โพลิกอน 7,640 (DWR)
- ⬜ ยังไม่มี key: NASA FIRMS (สำรองจุดความร้อน) · TMD uid/ukey ชุดเก่า (สถานีตรวจวัดจริง)
- ⚠️ `upsertStations()` อ่าน id กลับด้วย select ที่ PostgREST จำกัด 1,000 แถว — พอสำหรับ Air4Thai/TMD แต่ถ้าแหล่งไหน >1,000 สถานีและต้องเก็บ observations ต้องแบ่ง `.range()`

## บทเรียนจากการติดตั้งจริง (3 ก.ย. 2569 — อย่าทำซ้ำ)
- **revoke execute จาก public อย่างเดียวไม่พอ** — Supabase ตั้ง default privileges ให้ anon/authenticated ได้ EXECUTE โดยตรง ต้อง `revoke … from public, anon, authenticated, service_role` แล้ว grant กลับ (เจอ: anon เรียก purge_old_observations() ได้)
- **air4thai.pcd.go.th ส่ง TLS chain ผิด** (leaf Let's Encrypt YR1 แต่แนบ intermediate ของ Sectigo) → Deno ตอบ `UnknownIssuer` · แก้ด้วย `Deno.createHttpClient({ caCerts: [YR1] })` ในฟังก์ชัน · YR1 หมดอายุ 2 ก.ย. 2571 ต้องเปลี่ยนก่อนถึงวันนั้น
- **GISTDA MapServer ไม่รองรับ pagination** (`resultOffset`/`resultRecordCount` = error 400) → แบ่งหน้าด้วย `where FID > N` · geometry เป็น multipoint
- **DGR `?Page=N` คืน N×1000 แถวเริ่มที่ offset (N-1)×1000** (Page=60 = 58,723 แถว) ไม่มีพารามิเตอร์ขนาดหน้า → ใช้ลำดับหน้า 1,2,4,8,16,32,64 ทีละ 10k แถวต่อรอบ · แถวอยู่ใน `result`
- **Dashboard ควบคุมด้วยเบราว์เซอร์อัตโนมัติ**: ช่อง Secrets เป็น React input พิมพ์ด้วย synthetic key ไม่ติด ต้องใช้ native value setter + `input` event · สวิตช์ Verify JWT ก็ต้อง `el.click()` ผ่าน JS · Monaco ของ SQL Editor: `monaco.editor.getModels()[0].setValue()` แล้ว fetch ไฟล์จาก raw.githubusercontent.com ด้วย **commit SHA** (branch URL แคช ~5 นาที)
- **Nominatim ส่งคำนำหน้าเต็ม** ("อำเภอเมืองปทุมธานี") → strip ก่อนเติม อ./จ.
