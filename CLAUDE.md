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
- ✅ ข้อมูลจริงเข้าแล้ว: สถานี Air4Thai 173 · hotspot 1,533 · แผ่นดินไหว 10 · PM2.5 ดาวเทียม 77 จังหวัด · เรดาร์ 9 · **บ่อบาดาล DGR ครบรอบแล้ว 107,973 บ่อ** (4 ก.ย. 69 07:50 จาก api_total 117,634 — ที่เหลือไม่มีพิกัด/พิกัดนอกประเทศ) แล้ววนรอบใหม่ทุกชั่วโมง
- ✅ Edge **v1.2.1** (3 ก.ย. 69 ค่ำ): `upsert()` ตัดแถวที่คีย์ onConflict ซ้ำในชุดเดียว (แถวหลังชนะ) — DGR หน้า 8 มี `no` ซ้ำ ทำ cron dgr_wells ล้ม "ON CONFLICT DO UPDATE command cannot affect row a second time" ทุกชั่วโมงตั้งแต่ 14:50 · ตรวจ cron หลังลดขนาด DB: ทุก job succeeded, ทุกแหล่ง ok
- ✅ ผู้ใช้ admin: `wisemenow9@gmail.com` (สร้าง 3 ก.ย. 69)
- ✅ เฟส 2-3 นำเข้าแล้ว (3 ก.ย. 69, ผ่าน RPC import_* ด้วย session admin ในเบราว์เซอร์): ป่าสงวนแห่งชาติ 1,221 แปลง (layer `rfd_reserve_forest`, simplify 15 m) · ดินถล่ม DMR 56,177 จุด (events, `YEAR_DATA` ว่างทั้งหมด → occurred_at = 1970-01-01) · ศูนย์กลางตำบล 7,364 (stations `dopa_tambon`)
  ไฟล์ดิบ+GeoJSON อยู่ `data/raw/` (gitignore) · SHP ทั้งสองเป็น UTM zone 47 WGS84 มาใน .rar (แตกด้วย WinRAR ที่ `C:\Program Files\WinRAR\UnRAR.exe`)
- ✅ **DWR ArcGIS REST** (`https://gis.dwr.go.th/arcgis/rest/services` เปิดสาธารณะ 27 ชั้น — พบจากหน้า webgis.dwr.go.th/projects ที่เปิด web map ของ ArcGIS Enterprise) ดึงด้วย `scripts/fetch_arcgis.mjs` แล้วนำเข้าแล้ว (3 ก.ย. 69 บ่าย):
  ลุ่มน้ำหลัก 28 (`dwr_main_basin`) · ลุ่มน้ำสาขา 359 (`dwr_sub_basin`) · จังหวัด 77 (`dwr_province`) · อำเภอ 883 (`dwr_amphoe`) · แรมซาร์ 113 (`onep_ramsar`) · เขื่อน 1,087 (stations `dwr_dam`) · สถานีอุทกวิทยา 126 (`dwr_hyd_station`)
  ชั้นที่ยังไม่ดึง: Tambon 7,640 โพลิกอน · WELL 72,658 · NAT_WTR_BODY 28,394 · 25_BASIN · พื้นที่ชุ่มน้ำท้องถิ่น 36,408 จุด · ประสิทธิภาพการระบายน้ำ (เส้น)
- ✅ **โพลิกอนเก็บเป็นชิ้นย่อย** (migration 1000 แทน 700): `layer_features` เก็บชิ้นจาก `ST_Subdivide(…,256)` โดยตรง — 1 ฟีเจอร์ต้นฉบับ = หลายแถวที่ `ext_id/name_th/props` ซ้ำกัน (`insert_layer_feature()` ทำให้เอง) · ไม่มี `layer_features_idx` แล้ว · `site_report.layer_hits` ใช้ `distinct on (layer_id, ext_id, name_th)` · `layer_features_bbox` ส่งชิ้น (เส้นแบ่งชิ้นเห็นบนแผนที่ ยอมรับได้) · ที่มา: ก่อนมีชิ้นย่อย โพลิกอนลุ่มน้ำหลัก/แรมซาร์ทำให้ 57014 statement timeout
- ⚠️ **ขนาด DB Free 500 MB** (3 ก.ย. 69 ค่ำ): หลัง EIA/โรงงาน DB ขึ้น 537 MB → Dashboard "EXCEEDING USAGE LIMITS" · ผู้ใช้เลือกลดขนาดแทนอัป Pro → migration 1000 (เลิกเก็บโพลิกอนสองสำเนา + ตัด props โรงงานที่ซ้ำ) + `vacuum full` 3 ตาราง → **326 MB** (layer_features 182 · events 104 · stations 19) · ตรวจ site_report 3 จุดผลเท่าเดิม
  กติกา: ก่อนนำเข้าชั้นใหม่ให้ `select pg_size_pretty(pg_database_size(current_database()))` ก่อน · **อย่านำเข้า LDD landuse** (รายจังหวัด 3–130 MB ห้าม simplify) จนกว่าจะอัป Pro หรือย้ายชั้นใหญ่ไป Storage bucket/PMTiles · observations hourly เก็บ 180 วันจะโตราว 1–2 MB/วัน ถ้าใกล้เพดานให้ลดเป็น 90 วันใน `purge_old_observations`
- ✅ **เฟส 4 สภาพอากาศ (3 ก.ย. 69 เย็น)**: TMD **NWP API** (JWT ผู้ใช้สมัครเอง หมดอายุ ก.ย. 2570) เก็บเป็น Secret `TMD_NWP_TOKEN` · Edge `envi-ingest` v1.1.0 มี action สาธารณะ `{"action":"forecast","lat","lng"}` (ไม่ต้องมี cron token, CORS เปิด) แคช 1 ชม./พิกัดปัด 2 ตำแหน่งใน `api_cache` · แท็บสภาพอากาศแสดง 24 ชม. + 7 วัน
  ⚠️ ผู้ใช้ **ไม่ได้สมัคร TMD API ชุดเก่า (uid/ukey)** — handler `tmd_today`/`tmd_3h` (สถานีตรวจวัดจริง 122 สถานี) ยังรันไม่ได้ ถ้าต้องการต้องสมัครแยกที่ data.tmd.go.th/api
  ⚠️ token JWT ของ TMD ถูกวางในแชตตอนส่งให้ — ถ้ากังวลให้ revoke แล้วออกใหม่ที่ data.tmd.go.th/nwpapi แล้วอัปเดต Secret
- ✅ **เฟส 5 GISTDA api-gateway (3 ก.ย. 69 ค่ำ)**: Secret `GISTDA_API_KEY` (key ส่งเป็น `?api_key=` หรือ header `API-Key`) · Edge v1.2.0
  - handler `gistda_flood` (cron ทุก 6 ชม. เปิดแล้ว): STAC `flood/collections/flood1day_r2/items` → assets.data GeoJSON → RPC `replace_layer_features('gistda_flood_1d')` (migration 800, service_role เท่านั้น) · วันไม่มีน้ำท่วม = 0 โพลิกอน · flood3/7/30day ไม่มี item · gi-service flood-recurrence 404 ทุกเวอร์ชัน
  - action สาธารณะ `burnscar` {lat,lng}: `resources/features/burn-scar?bbox=±0.045°` (79,435 โพลิกอนทั้งประเทศ ไม่ควรนำเข้า) แคช 24 ชม. → แท็บภัยพิบัติแสดงจำนวน/ไร่/ชนิดที่ดิน + วาดโพลิกอนสีส้มด้วย GeoJsonDataSource
  - WMS flood-freq มี (Vallaris) แต่ต้องแนบ key ใน URL → ไม่ซ้อนในเบราว์เซอร์ (key จะหลุด) ถ้าจะใช้ต้อง proxy tile ผ่าน Edge
  - 🐛 แก้ไปด้วย: cron job เรดาร์เรียก `'royalrain'` แต่ id จริง `'royalrain_radar'` (ไม่เคยยิง) · คอมเมนต์ที่มี slash-star-slash ทำ bundler ของ Supabase พังตอน deploy
- ✅ ตำบลโพลิกอน DWR `dwr_tambon` 7,639/7,640 (3 ก.ย. 69) — แปลงที่ข้ามคือเศษ 4 จุดของ ต.สวาย อ.ปรางค์กู่ ศรีสะเกษ (TAMBON_IDN 330709 มี 2 ชิ้น ชิ้นจริงเข้าแล้ว) · TAMBON_IDN ซ้ำได้ (หลายชิ้นต่อตำบล) จึงมี ext_id ซ้ำ 170 แถว — ปกติ · ที่ตั้งในรายงานอ่านจากชั้นนี้ก่อน (ต./อ./จ.) แล้วค่อย Nominatim
- ✅ **พพ. แผนที่รังสีอาทิตย์** (3 ก.ย. 69): ชุด `sed01` ที่แคตตาล็อกบอกว่า "38 สถานี" จริง ๆ เป็น XLSX **รายตำบล 7,416 จุด พ.ศ. 2560** (จังหวัด/อำเภอ/ตำบล + lat/lon + 12 เดือน หน่วย MJ/m²/วัน ค่า 15–20) → stations `dede_solar` station_type `solar_grid`, meta {monthly[12], annual_avg_mj, annual_kwh_m2 (= MJ/3.6×365)} · แท็บแสงอาทิตย์แสดงตำบลใกล้สุด (nearest_stations 15 กม.) ก่อน NASA POWER — ที่ปทุมธานี พพ. 1,827 vs NASA 1,852 kWh/m²/ปี สอดคล้องกัน
  ⚠️ `nearest_stations()` ไม่คืน `meta` — ฝั่งเว็บต้อง `fetchStationMeta(station_id)` เพิ่ม (ถ้าจะแก้ให้คืน meta ต้องแก้ไฟล์ 3 แล้วรันซ้ำ)
- ✅ **โรงงาน กรมโรงงานฯ** (3 ก.ย. 69): CSV factype3 (จำพวก 3 ทั้งประเทศ 67,695, 39 MB) + factype2 (3,220) + fac101-105-106 (จัดการของเสีย 2,940) จาก data.go.th → events kind=other source `diw_factory` 68,116 แห่ง · **ไม่มีพิกัดในไฟล์** → ผูกกับศูนย์กลางตำบล `dopa_tambon` (ตำบล 97.7% / อำเภอ 2.3%) จึงเป็นความแม่นระดับตำบล · props: type_code/type_name/class/hp/workers/waste_handler · site_report `factories_5km` (migration 900) · gdcatalog.go.th ถูก Incapsula กัน curl — ใช้ data.go.th แทน
- ✅ **EIA (สผ. Smart EIA)** (3 ก.ย. 69 ค่ำ): ไม่มี API → `scripts/scrape_eia.mjs` (list = POST /site/eia 100 แถว/หน้า มี CSRF · detail = GET /eia/detail?id= ~45 นาที 4 พร้อมกัน) → `scripts/build_eia_rows.mjs` → events source `onep_eia` **13,350 โครงการ** (จาก 13,510: ไม่มีที่ตั้ง 160) พิกัด ตำบล 84% / อำเภอ 11% / จังหวัด 4% · props: category/subcategory/report_type/status/project_status/owner/consultant/location/approval_date · occurred_at = วันที่แจ้งเห็นชอบ · site_report `eia_20km` (มาบตาพุด 1,027 โครงการ, ปทุมธานี 566)
  ⚠️ บั๊กที่เจอ: parser ที่ตั้งรุ่นแรกใช้ lookahead กว้างจน "จังหวัด…" ถูกตัดทิ้ง — ตอนนี้ตัดค่าที่ป้ายถัดไปที่รู้จักเท่านั้น · ถ้าจะอัปเดตทะเบียน: รัน list ใหม่ แล้ว detail จะดึงเฉพาะ id ที่ยังไม่มีใน eia_detail.json
- ✅ **ระบบบำบัดน้ำเสีย คพ. DSPOT เข้าฐานจริง** (5 ก.ย. 69 ค่ำ): migration 1100 (sources `pcd_dspot`/`bma_wwtp`/`onep_pap`, `site_report.wwtp_10km` = ใกล้สุด 5 แห่งใน 10 กม., cron `envi_pcd_dspot` อังคาร 03:20 น.) + Edge **v1.3.0** handler `pcd_dspot`: ดึง HTML `https://dspot.pcd.go.th/database/s?area=` → parse `<script id="__NEXT_DATA__">` → `props.pageProps.reports[]` (อย่าใช้ `/_next/data/<buildId>/` เพราะ buildId เปลี่ยนทุก deploy · ไม่มี CORS) → stations `pcd_dspot` station_type `wwtp` **216 แห่ง** (meta: status/plant_type/operator/capacity/inflow_pct/pop/basin/discharge/wq{bod,tss,ph,tn,tp}/fee/photo) + observations 1,237 แถว (bod_in/out, tss, ph, inflow_pct, avg_inflow ณ `date_quality`)
  **กทม. 7 โรง (`bma_wwtp`) + สผ. 92 ระบบ (`onep_pap`) เข้า stations แล้ว** (5 ก.ย. 69 ค่ำ) ผ่าน `supabase/seed/wastewater_stations.sql` ที่ `scripts/build_wastewater_data.mjs` สร้าง (upsert ตาม source_id, ext_id รันซ้ำได้) · สผ. อีก 14 ระบบไม่มีที่ตั้งพอระบุพิกัดจึงไม่เข้า · หน้าเว็บ `web/wastewater.html` (Leaflet SPA แยกจาก index.html) อ่าน stations ทั้ง 3 source จาก Supabase ก่อน → fallback สแนปช็อต `web/data/wastewater.json` · พื้นแผนที่ ESRI ถนน/ดาวเทียม/ภูมิประเทศ + Google แผนที่/ดาวเทียม (tile URL `mt{0-3}.google.com/vt` ไม่มี key — ใช้ภายใน/ต้นแบบ ถ้าเผยแพร่สาธารณะควรใช้ Maps API key ตาม TOS) · มือถือ ≤900px: แผนที่บน + แผงแท็บ สรุป/รายการ/ที่มา ล่าง, ตัวกรองซ่อนหลังปุ่ม
  อจน. (wma.or.th, เดินระบบ 59 แห่ง) ไม่มี API สาธารณะ · ชุดรายจังหวัดบน gdcatalog เป็นสถิติรวม
- ⚠️ ขนาด DB **437 MB** (5 ก.ย. 69 ค่ำ) — โตจาก 326 เพราะบ่อบาดาล DGR ครบ 107,981 แถว · เหลือราว 60 MB ก่อนเพดาน Free · observations โต 1–2 MB/วัน → ควรลด `purge_old_observations` เป็น 90 วัน หรือ `vacuum full public.stations` หลังรอบ DGR (upsert ซ้ำทุกชั่วโมงทำ bloat)
  สำรวจ 5 ก.ย. 69: layer_features 183 MB (66,539 ชิ้น = 8 ชั้น ป่าสงวน 1,221 / ตำบล 7,485 / แรมซาร์ 113 / อำเภอ 882 / ลุ่มน้ำสาขา 359 / ลุ่มน้ำหลัก 28 / จังหวัด 77 / น้ำท่วม 0) · stations 113 MB (124,550 แถว 11 source; dgr_wells 107,981 · dede_solar 7,416 · dopa_tambon 7,364 · dwr_dam 1,087 · pcd_dspot 216 · air4thai 173 · dwr_hyd_station 126 · onep_pap 92 · gistda_pm25 77 · royalrain_radar 11 · bma_wwtp 7) · events 113 MB (139,200 แถว: diw_factory 68,116 · dmr_landslide 56,177 · onep_eia 13,350 · hotspot viirs 1,001 + modis 532 · tmd_quake 24) · observations 7 MB (61k hourly + 1,236 daily + 2,534 latest) · อื่น ๆ < 1 MB
  🐛 พบระหว่างสำรวจ: events hotspot ล่าสุด `occurred_at` = **2023-04-06** ทั้ง MODIS/VIIRS — GISTDA hotspot_daily MapServer อาจคืนชุดเก่า หรือ handler แปลงวันที่ผิด ต้องตรวจ `ingest_runs` + ค่า `ACQ_DATE` ของฟีเจอร์จริง
- ✅ **เซนเซอร์น้ำเรียลไทม์เข้าฐานแล้ว (5 ก.ย. 69 ค่ำ)** migration 1200 + Edge **v1.4.0**:
  - **กรมโรงงานฯ POMS** handler `diw_poms` (cron ทุก 15 นาที): `factory-ws/get/factory-list?page=N` → stations `diw_poms` station_type `factory_sensor` **796 โรงงาน** (800 − 4 พิกัดใช้ไม่ได้) · `get/measurement-list/{id}` แบ่ง 200 โรงงาน/รอบ ด้วย `cursor.offset` (ครบทุกชั่วโมง, concurrency 8) · parameter = `"<code>:<param>"` เช่น `P0078:COD` · **observations เก็บเฉพาะจุดวัดน้ำ (typeName ≠ CEMS)** ส่วน CEMS (ปล่องอากาศ) เก็บใน latest_observations อย่างเดียว extra {type, code, name, severity} · ไม่ต้องล็อกอิน แต่ไม่มี CORS และ endpoint ประวัติต้องล็อกอิน
  - **คพ. IWIS** handler `pcd_iwis` (cron นาที 10 ทุกชั่วโมง): `api-iwis.pcd.go.th/mst-station-with-summary?limit=200` (5.6 MB) → stations `pcd_iwis` station_type `river_auto` 64 สถานี · observations เฉพาะรอบนาที :00 จาก `water_quality_summary_50` (พารามิเตอร์ PH/DO/EC/Temp/Salinity/Tur/BOD/COD/NH4N) · latest ทุกพารามิเตอร์ + extra {level, color} ของ คพ.
  - `site_report` เพิ่ม `poms_5km` (nearest_stations 5 กม. 10 แห่ง) และ `iwis_20km` (3 แห่ง) — คืน latest jsonb ให้ด้วย · แดชบอร์ด `web/wastewater.html` ชั้น "โรงงานมีเซนเซอร์น้ำทิ้ง (POMS)" ◆ สีแดงเมื่อ severity ≥ 2 และ "สถานีคุณภาพน้ำแม่น้ำ (IWIS)" ▲ สีตามระดับ DO อ่านจาก `v_station_latest`
  - ⚠️ **เปลี่ยนอายุข้อมูลรายชั่วโมงเป็น 7 วัน** (`envi_purge_observations` ทุกวัน 19:00 UTC `purge_old_observations(7)`; เดิม 180 วัน/สัปดาห์) เพราะ Free เหลือ ~60 MB และแถวรายชั่วโมงรวม ≈ 57k แถว/วัน ≈ 7 MB/วัน · ประวัติยาวอยู่ใน `observations_daily` (rollup ทุกคืน ไม่ถูกลบ) · ถ้าอัป Pro ค่อยขยาย
  - ระบบบำบัดชุมชน 315 แห่งใน DB **ไม่มีเซนเซอร์** มีแค่ผลแล็บปีละครั้ง (DSPOT 159 ระบบ) · Dashboard ของ Supabase โหลดช้ามาก/ค้างช่วงมีเหตุขัดข้อง (status.supabase.com "API Gateway degraded") — ยิง handler ครั้งแรกจึงปล่อยให้ cron ทำแทน `trigger_ingest` ด้วยมือ
- ⬜ ยังไม่ได้นำเข้า: การใช้ที่ดิน LDD รายจังหวัด (**ข้ามไปก่อนตามที่ผู้ใช้เลือก 3 ก.ย. 69 — ติดขนาด DB Free**; ลิงก์ zip รายจังหวัดอยู่ `data/raw/ldd_links.json`) · ชั้นคุณภาพลุ่มน้ำ (ไม่มีบน ArcGIS ของ DWR)
- ⬜ ยังไม่มี key: NASA FIRMS (สำรองจุดความร้อน) · TMD uid/ukey ชุดเก่า (สถานีตรวจวัดจริง)
- ⚠️ `upsertStations()` อ่าน id กลับด้วย select ที่ PostgREST จำกัด 1,000 แถว — พอสำหรับ Air4Thai/TMD แต่ถ้าแหล่งไหน >1,000 สถานีและต้องเก็บ observations ต้องแบ่ง `.range()`

## บทเรียนจากการติดตั้งจริง (3 ก.ย. 2569 — อย่าทำซ้ำ)
- **revoke execute จาก public อย่างเดียวไม่พอ** — Supabase ตั้ง default privileges ให้ anon/authenticated ได้ EXECUTE โดยตรง ต้อง `revoke … from public, anon, authenticated, service_role` แล้ว grant กลับ (เจอ: anon เรียก purge_old_observations() ได้)
- **air4thai.pcd.go.th ส่ง TLS chain ผิด** (leaf Let's Encrypt YR1 แต่แนบ intermediate ของ Sectigo) → Deno ตอบ `UnknownIssuer` · แก้ด้วย `Deno.createHttpClient({ caCerts: [YR1] })` ในฟังก์ชัน · YR1 หมดอายุ 2 ก.ย. 2571 ต้องเปลี่ยนก่อนถึงวันนั้น
- **GISTDA MapServer ไม่รองรับ pagination** (`resultOffset`/`resultRecordCount` = error 400) → แบ่งหน้าด้วย `where FID > N` · geometry เป็น multipoint
- **DGR `?Page=N` คืน N×1000 แถวเริ่มที่ offset (N-1)×1000** (Page=60 = 58,723 แถว) ไม่มีพารามิเตอร์ขนาดหน้า → ใช้ลำดับหน้า 1,2,4,8,16,32,64 ทีละ 10k แถวต่อรอบ · แถวอยู่ใน `result`
- **Dashboard ควบคุมด้วยเบราว์เซอร์อัตโนมัติ**: ช่อง Secrets เป็น React input พิมพ์ด้วย synthetic key ไม่ติด ต้องใช้ native value setter + `input` event · สวิตช์ Verify JWT ก็ต้อง `el.click()` ผ่าน JS · Monaco ของ SQL Editor: `monaco.editor.getModels()[0].setValue()` แล้ว fetch ไฟล์จาก raw.githubusercontent.com ด้วย **commit SHA** (branch URL แคช ~5 นาที)
- **Nominatim ส่งคำนำหน้าเต็ม** ("อำเภอเมืองปทุมธานี") → strip ก่อนเติม อ./จ.
- **`vacuum full` ต้องรันทีละคำสั่งใน SQL Editor** (นอก transaction) หลัง migration ที่ลบ/ย้ายข้อมูลก้อนใหญ่ ไม่งั้นขนาด DB ไม่ลด · `pg_database_size` เป็นตัวเลขที่ Supabase ใช้คิดโควตา (ไม่ใช่ผลรวม pg_total_relation_size)
