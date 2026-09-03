-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — ทะเบียนแหล่งข้อมูลราชการ (ไฟล์ที่ 4/5)                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ทุกแถวมาจากการยิง endpoint จริงเมื่อ 3 ก.ย. 2569 (verified_at) ยกเว้นที่ระบุใน notes
-- รายละเอียดเต็มอยู่ใน docs/แหล่งข้อมูลราชการ.md
--
-- cron_enabled = false ทั้งหมดตอนติดตั้ง — เปิดทีละแหล่งหลังทดสอบ Invoke ผ่านแล้ว
--   update public.sources set cron_enabled = true where id = 'air4thai';
--
-- รันซ้ำได้ (upsert) — ไม่ทับ cron_enabled ที่ผู้ใช้ตั้งไว้แล้ว
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.sources
  (id, category, agency, name_th, url, access_mode, license, refresh_minutes, handler, verified_at, notes, meta)
values
-- ── อากาศ ──────────────────────────────────────────────────────────────────
('air4thai', 'air', 'กรมควบคุมมลพิษ', 'Air4Thai คุณภาพอากาศรายชั่วโมง ~200 สถานี',
 'http://air4thai.pcd.go.th/services/getNewAQI_JSON.php', 'open_json', 'ข้อมูลเปิดภาครัฐ', 60, 'air4thai', '2026-09-03',
 'HTTP only · ค่าเป็น string · -1/-999 = ไม่มีค่า · ไม่มี CORS ต้องผ่าน Edge',
 '{"history":"http://air4thai.pcd.go.th/forweb/getHistoryData.php?stationID=&param=PM25&type=hr&sdate=&edate=&stime=00&etime=23"}'),
('gistda_pm25', 'air', 'GISTDA', 'เช็คฝุ่น PM2.5 จากดาวเทียม (รายจังหวัด)',
 'https://pm25.gistda.or.th/rest/getPM25byProvince', 'open_json', 'ไม่ระบุ', 60, 'gistda_pm25', '2026-09-03',
 'ไม่มีเอกสาร อาจเปลี่ยนโดยไม่แจ้ง · มี getPM25byLocation?lat=&lng= ด้วย', '{}'),
('gistda_aq_tiles', 'air', 'GISTDA', 'แผนที่ PM2.5 รายชั่วโมง (ArcGIS tile)',
 'https://gistdaportal.gistda.or.th/data/rest/services/FR_Fire/AirQuality_hourly/MapServer', 'wms', 'ไม่ระบุ', null, null, '2026-09-03',
 'ซ้อนเป็น tile บนแผนที่ ไม่เก็บลง DB', '{}'),
('pcd_pm10_history', 'air', 'กรมควบคุมมลพิษ', 'PM10 รายวัน 2554-2567 (CSV)',
 'https://data.go.th/dataset/pm10', 'static_file', 'Open Data Common', null, null, '2026-09-03',
 'คอลัมน์เป็นรหัสสถานี ไม่มีพิกัด — join กับ stations ของ air4thai', '{}'),
('pcd_noise', 'air', 'กรมควบคุมมลพิษ', 'ระดับเสียงจากสถานีตรวจวัด (CSV รายปี)',
 'https://data.go.th/dataset/noise-monitor', 'static_file', 'Open Data Common', null, null, '2026-09-03', null, '{}'),

-- ── ภัยพิบัติ ───────────────────────────────────────────────────────────────
('gistda_hotspot_modis', 'disaster', 'GISTDA', 'จุดความร้อน MODIS รายวัน',
 'https://gistdaportal.gistda.or.th/data/rest/services/FR_Fire/hotspot_daily/MapServer/0', 'arcgis_rest', 'ไม่ระบุ', 360, 'gistda_hotspot', '2026-09-03',
 'สูงสุด 1000 แถว/คำขอ วน resultOffset', '{"layer":"hotspot_daily"}'),
('gistda_hotspot_viirs', 'disaster', 'GISTDA', 'จุดความร้อน VIIRS (Suomi NPP) รายวัน',
 'https://gistdaportal.gistda.or.th/data/rest/services/FR_Fire/hotspot_npp_daily/MapServer/0', 'arcgis_rest', 'ไม่ระบุ', 360, 'gistda_hotspot', '2026-09-03',
 'วันเดียวเกิน 1000 จุดได้', '{"layer":"hotspot_npp_daily"}'),
('tmd_quake', 'disaster', 'กรมอุตุนิยมวิทยา', 'แผ่นดินไหว (RSS 10 เหตุการณ์ล่าสุด)',
 'https://earthquake.tmd.go.th/feed/rss_tmd.xml', 'rss', 'ข้อมูลเปิดภาครัฐ', 15, 'tmd_quake', '2026-09-03',
 'geo:lat geo:long tmd:magnitude tmd:depth tmd:time', '{}'),
('dmr_landslide', 'disaster', 'กรมทรัพยากรธรณี', 'บัญชีดินถล่ม 2532-2562 (SHP/CSV)',
 'https://data.dmr.go.th/dataset/landslide_inventory_map', 'static_file', 'CC BY', null, null, '2026-09-03',
 'นำเข้าผ่านหน้า import เป็น events kind=landslide', '{}'),
('gistda_flood', 'disaster', 'GISTDA', 'พื้นที่น้ำท่วม 1/3/7/30 วัน (STAC/WMS)',
 'https://api-gateway.gistda.or.th/api/2.0/resources/stac/flood', 'key_json', 'ไม่ระบุ', 360, 'gistda_flood', '2026-09-03',
 'ต้องสมัคร api_key ที่ api-gateway.gistda.or.th (ยิงโดยไม่มี key ได้ 407)', '{}'),
('nasa_firms', 'disaster', 'NASA FIRMS (สำรอง)', 'จุดความร้อน VIIRS/MODIS ทั่วไทย',
 'https://firms.modaps.eosdis.nasa.gov/api/country/csv/{MAP_KEY}/VIIRS_SNPP_NRT/THA/1', 'key_json', 'NASA open', 180, 'firms', '2026-09-03',
 'MAP_KEY ฟรี · 5000 คำขอ/10 นาที', '{}'),
('ddpm_stats', 'disaster', 'กรมป้องกันและบรรเทาสาธารณภัย', 'สถิติภัยพิบัติ 2562-2568 (CSV)',
 'https://catalog.disaster.go.th/organization/dpm021', 'static_file', 'ไม่ระบุ', null, null, '2026-09-03', 'ระดับหมู่บ้าน/จังหวัด ไม่มีพิกัด', '{}'),

-- ── น้ำ / ธรณี ──────────────────────────────────────────────────────────────
('dgr_wells', 'water', 'กรมทรัพยากรน้ำบาดาล', 'บ่อน้ำบาดาล 117,605 บ่อ (JSON แบ่งหน้า)',
 'https://pasutara.dgr.go.th/api_well/api/FindWellAll', 'open_json', 'ไม่ระบุ', 10080, 'dgr_wells', '2026-09-03',
 '118 หน้า ใช้ cursor ใน ingest_runs · บางแถว lat/long ว่าง ข้ามไป', '{"page_size":1000}'),
('royalrain_radar', 'water', 'กรมฝนหลวงและการบินเกษตร', 'เรดาร์ฝน CAPPI 11 สถานี (รูปทุก 6 นาที)',
 'https://file.royalrain.go.th/opendata/radar_data/cappi/api.php?station=all-only-latest', 'open_json', 'ข้อมูลเปิดภาครัฐ', 30, 'royalrain', '2026-09-03',
 'คืน URL รูปภาพ ไม่ใช่ค่าตัวเลข', '{}'),
('dwr_basins', 'water', 'กรมทรัพยากรน้ำ', 'ลุ่มน้ำหลัก 22 ลุ่ม + ลุ่มน้ำสาขา 359 (ArcGIS REST)',
 'https://gis.dwr.go.th/arcgis/rest/services', 'arcgis_rest', 'ไม่ระบุ (เผยแพร่สาธารณะ)', null, null, '2026-09-03',
 'เซิร์ฟเวอร์ ArcGIS ของกรมเปิดสาธารณะ 27 ชั้น (Sub_Basin, ขอบเขตลุ่มน้ำหลัก, Province_2556, Amphoe_2556, Tambon, DAM, HYD_STATION, WELL, NAT_WTR_BODY …) ดึงด้วย scripts/fetch_arcgis.mjs · หน้า webgis.dwr.go.th/downloads ไม่จำเป็น', '{}'),
('dwr_admin', 'admin', 'กรมทรัพยากรน้ำ (ชุด กรมการปกครอง 2556)', 'ขอบเขตจังหวัด 77 / อำเภอ 883 / ตำบล 7,640 (โพลิกอน)',
 'https://gis.dwr.go.th/arcgis/rest/services/Province_2556/MapServer/0', 'arcgis_rest', 'ไม่ระบุ (เผยแพร่สาธารณะ)', null, null, '2026-09-03',
 'ชั้นขอบเขตการปกครองแบบโพลิกอนชุดเดียวที่ดึงอัตโนมัติได้ · Amphoe_2556, Tambon อยู่บนเซิร์ฟเวอร์เดียวกัน', '{}'),
('dwr_dam', 'water', 'กรมทรัพยากรน้ำ', 'เขื่อน/อ่างเก็บน้ำ 1,087 แห่ง (จุด)',
 'https://gis.dwr.go.th/arcgis/rest/services/DAM/MapServer/0', 'arcgis_rest', 'ไม่ระบุ (เผยแพร่สาธารณะ)', null, null, '2026-09-03', 'ฟิลด์ DAM_ID DAM_Name DAM_Type STATUS', '{}'),
('dwr_hyd_station', 'water', 'กรมทรัพยากรน้ำ', 'สถานีอุทกวิทยา 126 สถานี (จุด)',
 'https://gis.dwr.go.th/arcgis/rest/services/HYD_STATION/MapServer/0', 'arcgis_rest', 'ไม่ระบุ (เผยแพร่สาธารณะ)', null, null, '2026-09-03', 'ฟิลด์ Sta_Code Sta_Name River_Name Basin_Code', '{}'),
('onep_ramsar', 'forest', 'สผ. (ผ่านเซิร์ฟเวอร์กรมทรัพยากรน้ำ)', 'พื้นที่ชุ่มน้ำระดับนานาชาติ (แรมซาร์) 113 แปลง ฉบับ 1 ต.ค. 2563',
 'https://gis.dwr.go.th/arcgis/rest/services/Ramsar_Wetland_Revise_1Oct2020_by_ONEP/MapServer/0', 'arcgis_rest', 'ไม่ระบุ (เผยแพร่สาธารณะ)', null, null, '2026-09-03', null, '{}'),
('rid_reservoir', 'water', 'กรมชลประทาน', 'สถานการณ์น้ำในอ่างเก็บน้ำ',
 'https://app.rid.go.th/reservoir/', 'browser_only', 'ไม่ระบุ', null, null, '2026-09-03', 'HTML/Excel ไม่มี API · นำเข้าด้วยมือ', '{}'),
('hii_thaiwater', 'water', 'สถาบันสารสนเทศทรัพยากรน้ำ', 'คลังข้อมูลน้ำ (CKAN)',
 'https://data.hii.or.th', 'static_file', 'CC BY-NC', null, null, '2026-09-03', 'CKAN API ไม่ต้องใช้ key · NC = ห้ามใช้เชิงพาณิชย์', '{}'),
('pcd_water_quality', 'water', 'กรมควบคุมมลพิษ', 'คุณภาพน้ำผิวดิน/ทะเลชายฝั่ง (CSV)',
 'https://data.go.th/organization/pcd', 'static_file', 'Open Data Common', null, null, '2026-09-03', null, '{}'),

-- ── ป่าไม้ / ที่ดิน ─────────────────────────────────────────────────────────
('rfd_reserve_forest', 'forest', 'กรมป่าไม้', 'ป่าสงวนแห่งชาติ 1,221 แปลง (SHP/GeoJSON/WFS)',
 'https://data.forest.go.th/dataset/reserve_forest', 'static_file', 'Open Data Common', null, null, '2026-09-03',
 'ไม่ใช่แนวเขตทางกฎหมาย (disclaimer ของกรม)', '{}'),
('ldd_landuse', 'land', 'กรมพัฒนาที่ดิน', 'การใช้ที่ดิน 1:25,000 รายจังหวัด (SHP)',
 'https://tswc.ldd.go.th/DownloadGIS/Index_Lu.html', 'static_file', 'CC BY-NC-ND', null, null, '2026-09-03',
 'ND = ห้ามดัดแปลงรูปทรง ส่ง p_tolerance=0 เสมอ', '{}'),
('dopa_tambon', 'admin', 'กรมการปกครอง (ผ่าน GISTDA)', 'จุดศูนย์กลางตำบล',
 'http://gistdaportal.gistda.or.th/data/rest/services/opendata/Tambon/MapServer', 'arcgis_rest', 'DGA Open Government License', null, null, '2026-09-03', 'HTTP only', '{}'),

-- ── EIA / โรงงาน / ขยะ ──────────────────────────────────────────────────────
('onep_eia', 'eia', 'สำนักงานนโยบายและแผนทรัพยากรธรรมชาติและสิ่งแวดล้อม', 'Smart EIA Plus 13,508 โครงการ',
 'https://eia.onep.go.th/site/eia', 'browser_only', 'ไม่ระบุ', null, null, '2026-09-03', 'ไม่มี API ไม่มีพิกัด · นำเข้า CSV ด้วยมือ', '{}'),
('diw_factory', 'eia', 'กรมโรงงานอุตสาหกรรม', 'โรงงานประเภท 101/105/106 (CSV รายเดือน)',
 'https://gdcatalog.go.th/dataset/gdpublish-diw-d01-01', 'static_file', 'ไม่ระบุ', null, null, '2026-09-03', 'ระดับตำบล ไม่มีพิกัด', '{}'),
('pcd_waste', 'waste', 'กรมควบคุมมลพิษ', 'สถานการณ์ขยะมูลฝอยรายจังหวัด',
 'https://thaimsw.pcd.go.th/report_country.php', 'browser_only', 'ไม่ระบุ', null, null, '2026-09-03', 'HTML เท่านั้น', '{}'),
('tgo_tver', 'eia', 'องค์การบริหารจัดการก๊าซเรือนกระจก', 'โครงการ T-VER',
 'https://ghgreduction.tgo.or.th/', 'browser_only', 'ไม่ระบุ', null, null, '2026-09-03', null, '{}'),

-- ── อุตุนิยมวิทยา (เฟส 4) ────────────────────────────────────────────────────
('tmd_today', 'weather', 'กรมอุตุนิยมวิทยา', 'สภาพอากาศวันนี้ 122 สถานี',
 'https://data.tmd.go.th/api/WeatherToday/V2/', 'key_json', 'ข้อมูลเปิดภาครัฐ', 180, 'tmd_today', '2026-09-03',
 'ต้องสมัคร uid/ukey ที่ data.tmd.go.th (ฟรี)', '{"station_list":"https://data.tmd.go.th/api/Station/v1/"}'),
('tmd_3h', 'weather', 'กรมอุตุนิยมวิทยา', 'ตรวจอากาศทุก 3 ชั่วโมง',
 'https://data.tmd.go.th/api/Weather3Hours/V2/', 'key_json', 'ข้อมูลเปิดภาครัฐ', 180, 'tmd_3h', '2026-09-03', null, '{}'),
('tmd_nwp', 'weather', 'กรมอุตุนิยมวิทยา', 'พยากรณ์กริด 2 กม. รายชั่วโมง 48 ชม. + รายวัน 7 วัน (NWP API)',
 'https://data.tmd.go.th/nwpapi/v1/forecast/location/hourly/at', 'key_json', 'ข้อมูลเปิดภาครัฐ', null, 'forecast', '2026-09-03',
 'ใช้งานแล้ว 3 ก.ย. 69: Secret TMD_NWP_TOKEN (JWT หมดอายุ ก.ย. 2570) · เบราว์เซอร์เรียก Edge action "forecast" แคช 1 ชม./จุด · TMD นับ datapoint และมี 429 · เอกสาร data.tmd.go.th/nwpapi/doc/apidoc/forecast_location.html', '{"fields_hourly":"tc,rh,slp,rain,ws10m,wd10m,cloudlow,cloudmed,cloudhigh,cond","fields_daily":"tc_max,tc_min,rh,rain,cond","cond":"1 แจ่มใส 2 เมฆบางส่วน 3 เมฆเป็นส่วนมาก 4 เมฆมาก 5 ฝนเล็กน้อย 6 ฝนปานกลาง 7 ฝนหนัก 8 ฝนฟ้าคะนอง 9 หนาวจัด 10 หนาว 11 เย็น 12 ร้อนจัด"}'),

-- ── แสงอาทิตย์ (เฟส 4) ───────────────────────────────────────────────────────
('nasa_power', 'solar', 'NASA POWER', 'รังสีอาทิตย์/อุณหภูมิ/ลม รายวัน 0.5°',
 'https://power.larc.nasa.gov/api/temporal/daily/point', 'open_json', 'NASA open', null, null, '2026-09-03', 'เบราว์เซอร์เรียกสด → api_cache', '{}'),
('pvgis', 'solar', 'EU JRC PVGIS 5.3', 'ผลผลิต PV / รายชั่วโมง / TMY',
 'https://re.jrc.ec.europa.eu/api/v5_3/', 'open_json', 'JRC open', null, null, '2026-09-03', '30 คำขอ/วินาที/IP · เบราว์เซอร์เรียกสด', '{}'),
('dede_solar', 'solar', 'กรมพัฒนาพลังงานทดแทนและอนุรักษ์พลังงาน', 'รังสีอาทิตย์ 38 สถานี (XLSX รายปี)',
 'https://pei.dede.go.th/dataset/sed01', 'static_file', 'CC BY', null, null, '2026-09-03', 'นำเข้าเป็น stations + observations_daily', '{}'),
('nasa_gibs_ndvi', 'vegetation', 'NASA GIBS', 'MODIS NDVI 8 วัน (WMTS)',
 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/', 'wms', 'NASA open', null, null, '2026-09-03', 'tile สด คงจากไฟล์ V2.9.0', '{}')

on conflict (id) do update set
  category = excluded.category, agency = excluded.agency, name_th = excluded.name_th,
  url = excluded.url, access_mode = excluded.access_mode, license = excluded.license,
  refresh_minutes = excluded.refresh_minutes, handler = excluded.handler,
  verified_at = excluded.verified_at, notes = excluded.notes,
  meta = public.sources.meta || excluded.meta;
  -- ตั้งใจไม่ทับ cron_enabled

-- ── ตรวจผล ──────────────────────────────────────────────────────────────────
select category as "หมวด", count(*) as "แหล่ง",
       count(*) filter (where handler is not null) as "ดึงอัตโนมัติได้",
       count(*) filter (where cron_enabled) as "เปิด cron แล้ว"
  from public.sources group by 1 order by 1;
