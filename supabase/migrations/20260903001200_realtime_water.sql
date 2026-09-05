-- ═══════════════════════════════════════════════════════════════════════════
-- 20260903001200_realtime_water.sql — เซนเซอร์น้ำเรียลไทม์: POMS กรมโรงงานฯ + IWIS คพ.
--
-- ทำอะไร
--   1. sources diw_poms (น้ำทิ้งโรงงาน WPMS + ปล่อง CEMS, 800 โรงงาน) และ pcd_iwis (สถานีคุณภาพน้ำแม่น้ำอัตโนมัติ 64 สถานี)
--   2. site_report เพิ่ม poms_5km (โรงงานมีเซนเซอร์ใน 5 กม. + ค่าล่าสุด) และ iwis_20km (สถานีแม่น้ำใกล้สุด 3 แห่งใน 20 กม.)
--   3. cron: envi_diw_poms ทุก 15 นาที (handler แบ่ง 200 โรงงาน/รอบ → ครบ 800 ทุกชั่วโมง) · envi_pcd_iwis ทุกชั่วโมง
--   4. ⚠️ อายุข้อมูลรายชั่วโมง: purge ทุกวัน เก็บ 7 วัน (เดิม 180 วัน สัปดาห์ละครั้ง)
--      เหตุผล: DB Free 500 MB เหลือ ~60 MB · แถวรายชั่วโมง ≈ 126 B/แถว · Air4Thai 29k + POMS ~20k + IWIS ~8k ≈ 57k แถว/วัน ≈ 7 MB/วัน
--      → 7 วัน ≈ 50 MB · ประวัติระยะยาวอยู่ใน observations_daily (rollup_daily ทุกคืน ไม่ถูกลบ)
--
-- รันซ้ำได้ · รันหลัง 1100 · ต้อง deploy Edge v1.4.0 (handler diw_poms, pcd_iwis) ก่อนยิง
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ทะเบียนแหล่ง ─────────────────────────────────────────────────────────
insert into public.sources
  (id, category, agency, name_th, url, access_mode, license, refresh_minutes, cron_enabled, handler, verified_at, notes, meta)
values
('diw_poms', 'water', 'กรมโรงงานอุตสาหกรรม', 'POMS/WPMS เซนเซอร์น้ำทิ้งและปล่องอากาศโรงงาน (800 โรงงาน · น้ำทิ้ง 348)',
 'https://poms.diw.go.th/factory-ws', 'open_json', 'ไม่ระบุ (เปิดสาธารณะผ่านแอป POMS)', 15, true, 'diw_poms', '2026-09-05',
 'factory-ws/get/factory-list?page=N (50/หน้า มี geom POINT(lng lat)) · get/measurement-list/{id} ค่าล่าสุดรายชั่วโมงต่อจุดวัด (WPMS: COD/BOD/Flow/Watt · CEMS: O2/Particulate/CO/SO2/NOx/Temp/Flow) · ไม่ต้องล็อกอิน แต่ไม่มี CORS · ประวัติ (get/measurement/{id}) ต้องล็อกอิน → cron เก็บเอง · observations เก็บเฉพาะ WPMS (น้ำ) ส่วน CEMS เก็บใน latest_observations อย่างเดียว (ประหยัดที่) · handler แบ่ง 200 โรงงาน/รอบ ด้วย cursor',
 '{"station_type":"factory_sensor","slice":200,"water_types":["WPMS","OPMS"]}'),
('pcd_iwis', 'water', 'กรมควบคุมมลพิษ', 'IWIS สถานีตรวจวัดคุณภาพน้ำแหล่งน้ำผิวดินอัตโนมัติ (64 สถานี ทุก 30 นาที)',
 'https://api-iwis.pcd.go.th/mst-station-with-summary?limit=200&page=1', 'open_json', 'ไม่ระบุ (เปิดสาธารณะ iwis.pcd.go.th)', 60, true, 'pcd_iwis', '2026-09-05',
 'JSON {statusCode,result:{data[]}} 5.6 MB มี station_lat/lng, water_quality_summary_50 (50 รอบล่าสุด ทุก 30 นาที) SUMMARY_JSON.data[{parameter,value,level,color}] พารามิเตอร์ PH/DO/EC/Temp/Salinity/Tur/BOD/COD/NH4N · มี CORS * · เก็บ observations เฉพาะรอบนาที :00 (รายชั่วโมง) · latest เก็บทุกพารามิเตอร์ + level/color · หน้าเว็บ iwis.pcd.go.th/auto-dashboard',
 '{"station_type":"river_auto","units":{"DO":"mg/L","PH":"","EC":"µS/cm","Temp":"°C","Salinity":"ppt","Tur":"NTU","BOD":"mg/L","COD":"mg/L","NH4N":"mg/L"}}')
on conflict (id) do update set
  category = excluded.category, agency = excluded.agency, name_th = excluded.name_th,
  url = excluded.url, access_mode = excluded.access_mode, license = excluded.license,
  refresh_minutes = excluded.refresh_minutes, cron_enabled = excluded.cron_enabled, handler = excluded.handler,
  verified_at = excluded.verified_at, notes = excluded.notes, meta = excluded.meta;

-- ── 2. site_report + poms_5km / iwis_20km ──────────────────────────────────
-- เหมือนไฟล์ 1100 ทุกอย่าง เพิ่ม v_poms (nearest_stations รัศมี 5 กม. 10 แห่ง) และ v_iwis (20 กม. 3 แห่ง) — nearest_stations คืน latest jsonb ให้แล้ว
create or replace function public.site_report(p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  pt geometry  := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_air jsonb; v_pm25sat jsonb; v_weather jsonb; v_hot jsonb; v_quake jsonb;
  v_slide jsonb; v_wells jsonb; v_layers jsonb; v_solar jsonb; v_flood jsonb; v_dams jsonb; v_fac jsonb; v_eia jsonb; v_wwtp jsonb;
  v_poms jsonb; v_iwis jsonb;
begin
  select to_jsonb(n) into v_air     from public.nearest_stations(p_lat, p_lng, 50000, 'air4thai', 1) n;
  select to_jsonb(n) into v_pm25sat from public.nearest_stations(p_lat, p_lng, 30000, 'gistda_pm25', 1) n;
  select to_jsonb(n) into v_weather from public.nearest_stations(p_lat, p_lng, 100000, 'tmd_', 1) n;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(to_jsonb(n) order by n.distance_m), '[]'::jsonb)) into v_poms from public.nearest_stations(p_lat, p_lng, 5000, 'diw_poms', 10) n;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(to_jsonb(n) order by n.distance_m), '[]'::jsonb)) into v_iwis from public.nearest_stations(p_lat, p_lng, 20000, 'pcd_iwis', 3) n;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object('at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'frp', e.magnitude, 'distance_m', round(ST_Distance(e.geom, g)), 'source', e.source_id, 'props', e.props) order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb)) into v_hot
    from (select * from public.events e where e.kind = 'hotspot' and e.occurred_at >= now() - interval '7 days' and ST_DWithin(e.geom, g, 10000) order by e.occurred_at desc limit 50) e;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object('at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'magnitude', e.magnitude, 'title', e.title, 'distance_km', round((ST_Distance(e.geom, g) / 1000)::numeric, 1), 'props', e.props) order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb)) into v_quake
    from (select * from public.events e where e.kind = 'earthquake' and e.occurred_at >= now() - interval '30 days' and ST_DWithin(e.geom, g, 300000) order by e.occurred_at desc limit 20) e;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object('at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'title', e.title, 'distance_m', round(ST_Distance(e.geom, g)), 'props', e.props) order by ST_Distance(e.geom, g)) filter (where e.id is not null), '[]'::jsonb)) into v_slide
    from (select * from public.events e where e.kind = 'landslide' and ST_DWithin(e.geom, g, 10000) order by e.geom <-> g limit 50) e;
  select jsonb_build_object('count', count(*)) into v_flood from public.events e where e.kind = 'flood' and e.occurred_at >= now() - interval '30 days' and ST_DWithin(e.geom, g, 20000);
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object('name', s.name_th, 'area', s.area_th, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta) order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb)) into v_wells
    from (select * from public.stations s where s.source_id = 'dgr_wells' and s.active and ST_DWithin(s.geom, g, 5000) order by s.geom <-> g limit 20) s;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object('name', s.name_th, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta) order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb)) into v_dams
    from (select * from public.stations s where s.source_id = 'dwr_dam' and s.active and ST_DWithin(s.geom, g, 20000) order by s.geom <-> g limit 10) s;
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name_th, 'area', s.area_th, 'province', s.province, 'lat', s.lat, 'lng', s.lng, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta) order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb)) into v_wwtp
    from (select * from public.stations s where s.source_id = 'pcd_dspot' and s.active and ST_DWithin(s.geom, g, 10000) order by s.geom <-> g limit 5) s;
  select jsonb_build_object(
           'count', (select count(*) from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000)),
           'waste_handlers', (select count(*) from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000) and (e.props->>'waste_handler')::boolean),
           'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', t.type_name, 'n', t.n) order by t.n desc), '[]'::jsonb) from (select e.props->>'type_name' as type_name, count(*) as n from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000) group by 1 order by 2 desc limit 6) t),
           'items', (select coalesce(jsonb_agg(jsonb_build_object('name', e.title, 'type', e.props->>'type_name', 'class', e.props->>'class', 'hp', e.props->>'hp', 'workers', e.props->>'workers', 'tambon', e.props->>'tambon', 'amphoe', e.props->>'amphoe', 'waste_handler', e.props->>'waste_handler', 'distance_m', round(ST_Distance(e.geom, g))) order by ST_Distance(e.geom, g)), '[]'::jsonb)
                       from (select * from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000) order by (e.props->>'waste_handler')::boolean desc nulls last, e.geom <-> g limit 15) e))
    into v_fac;
  select jsonb_build_object(
           'count', (select count(*) from public.events e where e.source_id = 'onep_eia' and ST_DWithin(e.geom, g, 20000)),
           'items', (select coalesce(jsonb_agg(jsonb_build_object('name', e.title, 'category', e.props->>'category', 'status', e.props->>'status', 'report_type', e.props->>'report_type', 'approval_date', e.props->>'approval_date', 'owner', e.props->>'owner', 'location', e.props->>'location', 'id', e.ext_id, 'distance_m', round(ST_Distance(e.geom, g))) order by ST_Distance(e.geom, g)), '[]'::jsonb)
                       from (select * from public.events e where e.source_id = 'onep_eia' and ST_DWithin(e.geom, g, 20000) order by e.geom <-> g limit 15) e))
    into v_eia;
  select coalesce(jsonb_agg(jsonb_build_object('layer_id', h.layer_id, 'layer', l.name_th, 'feature', h.name_th, 'props', h.props) order by h.layer_id), '[]'::jsonb)
    into v_layers
    from (select distinct on (f.layer_id, f.ext_id, f.name_th) f.layer_id, f.ext_id, f.name_th, f.props
            from public.layer_features f where ST_Contains(f.geom, pt)) h
    join public.layers l on l.id = h.layer_id;
  select c.payload || jsonb_build_object('fetched_at', c.fetched_at) into v_solar from public.api_cache c
   where c.cache_key = 'nasa_power:' || round(p_lat::numeric, 2) || ',' || round(p_lng::numeric, 2);
  return jsonb_build_object('generated_at', now(), 'lat', p_lat, 'lng', p_lng, 'air', v_air, 'pm25_sat', v_pm25sat, 'weather', v_weather,
    'hotspots_7d_10km', v_hot, 'quakes_30d_300km', v_quake, 'landslides_10km', v_slide, 'floods_30d_20km', v_flood, 'wells_5km', v_wells,
    'dams_20km', v_dams, 'wwtp_10km', v_wwtp, 'poms_5km', v_poms, 'iwis_20km', v_iwis, 'factories_5km', v_fac, 'eia_20km', v_eia, 'layer_hits', v_layers, 'solar_cache', v_solar);
end $$;

revoke execute on function public.site_report(double precision, double precision) from public, anon, authenticated, service_role;
grant  execute on function public.site_report(double precision, double precision) to anon, authenticated, service_role;
alter function public.site_report(double precision, double precision) set statement_timeout = '15s';

-- ── 3. cron ─────────────────────────────────────────────────────────────────
do $$
declare
  j record;
  jobs constant jsonb := '[
    {"name":"envi_diw_poms",            "cron":"*/15 * * * *", "sql":"select public.trigger_ingest(''diw_poms'')"},
    {"name":"envi_pcd_iwis",            "cron":"10 * * * *",   "sql":"select public.trigger_ingest(''pcd_iwis'')"},
    {"name":"envi_purge_observations",  "cron":"0 19 * * *",   "sql":"select public.purge_old_observations(7)"}
  ]'::jsonb;
begin
  for j in select * from jsonb_to_recordset(jobs) as x(name text, cron text, sql text) loop
    perform cron.unschedule(jobid) from cron.job where jobname = j.name;
    perform cron.schedule(j.name, j.cron, j.sql);
  end loop;
end $$;

-- ── ตรวจผล (แสดงทุกแถว) ──────────────────────────────────────────────────────
select s.id, s.cron_enabled, s.handler, s.refresh_minutes,
       (select count(*) from public.stations st where st.source_id = s.id) as stations,
       (select jobname || ' @ ' || schedule from cron.job where jobname = 'envi_' || s.id) as cron_job
  from public.sources s where s.id in ('diw_poms', 'pcd_iwis') order by s.id
union all
select 'purge', null, null, null, (select count(*) from public.observations), (select jobname || ' @ ' || schedule || ' → ' || command from cron.job where jobname = 'envi_purge_observations');
