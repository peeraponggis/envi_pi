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

## สถานะ (3 ก.ย. 2569)
- ✅ โค้ดเฟส 0-1 ครบ: SQL 8 ไฟล์ · Edge Function handlers air4thai/gistda_pm25/gistda_hotspot/tmd_quake/dgr_wells/royalrain/tmd_obs · หน้าเว็บ index + import · เทสต์
- ⏳ รอผู้ใช้: สร้างโปรเจกต์ Supabase → กรอก config.js → รัน SQL → deploy Edge → ตั้ง Vault/Secrets (ตาม docs/ขั้นตอนติดตั้ง)
- ⬜ ยังไม่ได้ทดสอบกับ Supabase จริง — **โครงสร้าง JSON ของ GISTDA PM2.5 / hotspot / DGR เขียนแบบเดา (defensive pick)** ต้องดูผลจริงรอบแรกแล้วปรับ handler
- ⬜ เฟส 2-3: นำเข้า SHP (ป่าสงวน ลุ่มน้ำ ดินถล่ม) · เฟส 4: TMD key + DEDE · เฟส 5: GISTDA gateway key
