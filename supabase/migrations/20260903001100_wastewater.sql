-- ═══════════════════════════════════════════════════════════════════════════
-- 20260903001100_wastewater.sql — ระบบบำบัดน้ำเสีย (คพ. DSPOT) เข้าฐานจริง
--
-- ทำอะไร
--   1. เพิ่มแหล่ง pcd_dspot (Edge handler ดึงทุกสัปดาห์), bma_wwtp, onep_pap ลงทะเบียน sources
--   2. site_report เพิ่มคีย์ wwtp_10km = ระบบบำบัดน้ำเสียใน 10 กม. (จาก stations source pcd_dspot)
--   3. cron envi_pcd_dspot ทุกวันอังคาร 03:20 น. ไทย (20:20 UTC จันทร์) — รายงาน DSPOT อัปเดตปีละครั้ง จึงพอ
--
-- รันซ้ำได้ · รันหลัง 1000 · ต้อง deploy Edge v1.3.0 (handler pcd_dspot) ก่อนยิง
-- ที่มา: dspot.pcd.go.th เป็น Next.js ฝัง JSON ใน <script id="__NEXT_DATA__"> (216 ระบบ, lat/lng, BOD/TSS/pH เข้า-ออก) ไม่มี CORS
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ทะเบียนแหล่ง ─────────────────────────────────────────────────────────
insert into public.sources
  (id, category, agency, name_th, url, access_mode, license, refresh_minutes, cron_enabled, handler, verified_at, notes, meta)
values
('pcd_dspot', 'water', 'กรมควบคุมมลพิษ', 'DSPOT ระบบบำบัดน้ำเสียรวมชุมชน/กลุ่มอาคาร ทั้งประเทศ (216 ระบบ)',
 'https://dspot.pcd.go.th/database/s?area=', 'browser_only', 'ไม่ระบุ (ฐานข้อมูลสาธารณะ คพ.)', 10080, true, 'pcd_dspot', '2026-09-05',
 'หน้า Next.js ฝัง JSON ใน __NEXT_DATA__.props.pageProps.reports — handler ดึง HTML แล้ว parse (อย่าใช้ /_next/data/<buildId>/ เพราะ buildId เปลี่ยนทุก deploy) · ไม่มี CORS · รายงานปี 2568 มีความสามารถ, น้ำเข้าจริง, BOD/TSS/pH/TN/TP เข้า-ออก, ผู้เดินระบบ, ค่าบริการ → stations station_type=wwtp + observations (observed_at = วันตรวจคุณภาพน้ำ)',
 '{"station_type":"wwtp","parameters":["bod_in","bod_out","tss_in","tss_out","ph_in","ph_out","inflow_pct","avg_inflow"]}'),
('bma_wwtp', 'water', 'กรุงเทพมหานคร สำนักการระบายน้ำ', 'โรงควบคุมคุณภาพน้ำ กทม. 7 แห่ง + ปริมาณบำบัดจริงรายเดือน',
 'https://data.bangkok.go.th/dataset/http-bitly-ws-sk3a', 'static_file', 'Open Data Common', null, false, null, '2026-09-05',
 'CKAN data.bangkok.go.th: wastewater.csv (พิกัด UTM 47N X/Y) · report-plant-qwater dds006-.csv (cp874, รายเดือน) · ตอนนี้ใช้เป็นสแนปช็อตใน web/data/wastewater.json ยังไม่เข้า stations', '{}'),
('onep_pap', 'water', 'สำนักงานนโยบายและแผนทรัพยากรธรรมชาติและสิ่งแวดล้อม', 'ระบบบำบัดน้ำเสียรวมที่ได้เงินอุดหนุนแผนปฏิบัติการฯ จังหวัด (106 ระบบ)',
 'https://www.onep.go.th/data/wastewater-treatment-system.csv', 'static_file', 'Open Data Common', null, false, null, '2026-09-05',
 'CSV ไม่มีพิกัด (ที่ตั้งเป็นข้อความ) → geocode ศูนย์กลางตำบล 75 / อำเภอ 17 / ไม่ได้ 14 · ส่วนใหญ่ซ้ำกับ DSPOT ใช้เติมปีงบประมาณ/แหล่งงบ · สแนปช็อตใน web/data/wastewater.json', '{"geocode":"tambon_centroid"}')
on conflict (id) do update set
  category = excluded.category, agency = excluded.agency, name_th = excluded.name_th,
  url = excluded.url, access_mode = excluded.access_mode, license = excluded.license,
  refresh_minutes = excluded.refresh_minutes, cron_enabled = excluded.cron_enabled, handler = excluded.handler,
  verified_at = excluded.verified_at, notes = excluded.notes, meta = excluded.meta;

-- ── 2. site_report + wwtp_10km ─────────────────────────────────────────────
-- เหมือนไฟล์ 1000 ทุกอย่าง เพิ่มเฉพาะ v_wwtp (ระบบบำบัดน้ำเสียใน 10 กม. ใกล้สุด 5 แห่ง พร้อม meta ทั้งก้อน)
create or replace function public.site_report(p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  pt geometry  := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_air jsonb; v_pm25sat jsonb; v_weather jsonb; v_hot jsonb; v_quake jsonb;
  v_slide jsonb; v_wells jsonb; v_layers jsonb; v_solar jsonb; v_flood jsonb; v_dams jsonb; v_fac jsonb; v_eia jsonb; v_wwtp jsonb;
begin
  select to_jsonb(n) into v_air     from public.nearest_stations(p_lat, p_lng, 50000, 'air4thai', 1) n;
  select to_jsonb(n) into v_pm25sat from public.nearest_stations(p_lat, p_lng, 30000, 'gistda_pm25', 1) n;
  select to_jsonb(n) into v_weather from public.nearest_stations(p_lat, p_lng, 100000, 'tmd_', 1) n;
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
  -- ระบบบำบัดน้ำเสีย (คพ. DSPOT) ใน 10 กม.
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
    'dams_20km', v_dams, 'wwtp_10km', v_wwtp, 'factories_5km', v_fac, 'eia_20km', v_eia, 'layer_hits', v_layers, 'solar_cache', v_solar);
end $$;

revoke execute on function public.site_report(double precision, double precision) from public, anon, authenticated, service_role;
grant  execute on function public.site_report(double precision, double precision) to anon, authenticated, service_role;
alter function public.site_report(double precision, double precision) set statement_timeout = '15s';

-- ── 3. cron รายสัปดาห์ ───────────────────────────────────────────────────────
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'envi_pcd_dspot';
  perform cron.schedule('envi_pcd_dspot', '20 20 * * 1', 'select public.trigger_ingest(''pcd_dspot'')');
end $$;

-- ── ตรวจผล (แสดงทุกแถว) ──────────────────────────────────────────────────────
select s.id, s.cron_enabled, s.handler, s.refresh_minutes,
       (select count(*) from public.stations st where st.source_id = s.id) as stations,
       (select jobname || ' @ ' || schedule from cron.job where jobname = 'envi_' || s.id) as cron_job
  from public.sources s where s.id in ('pcd_dspot', 'bma_wwtp', 'onep_pap') order by s.id;
