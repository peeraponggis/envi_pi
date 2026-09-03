-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — site_report เพิ่มหมวดโรงงาน (กรมโรงงานฯ) และโครงการ EIA (สผ.) (ไฟล์เสริม 9) ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- โรงงาน: events kind='other' source_id='diw_factory' 68,116 แห่ง (3 ก.ย. 2569) — พิกัดเป็น **ศูนย์กลางตำบล**
--   (CSV ของกรมมีแค่ที่อยู่ระดับตำบล) → รายงานเป็น "โรงงานในรัศมี 5 กม." โดยนับจากศูนย์กลางตำบล ไม่ใช่ที่ตั้งจริง
-- EIA: events kind='other' source_id='onep_eia' — ที่ตั้งจากหน้ารายละเอียด Smart EIA (ตำบล/อำเภอ) → ศูนย์กลางตำบล/อำเภอ
-- นิยามส่วนอื่นของ site_report เหมือนไฟล์ 7 ทุกประการ (เปลี่ยนเฉพาะสองบล็อกใหม่ + คีย์ผลลัพธ์)
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.site_report(p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  pt geometry  := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_air jsonb; v_pm25sat jsonb; v_weather jsonb; v_hot jsonb; v_quake jsonb;
  v_slide jsonb; v_wells jsonb; v_layers jsonb; v_solar jsonb; v_flood jsonb; v_dams jsonb;
  v_fac jsonb; v_eia jsonb;
begin
  select to_jsonb(n) into v_air     from public.nearest_stations(p_lat, p_lng, 50000, 'air4thai', 1) n;
  select to_jsonb(n) into v_pm25sat from public.nearest_stations(p_lat, p_lng, 30000, 'gistda_pm25', 1) n;
  select to_jsonb(n) into v_weather from public.nearest_stations(p_lat, p_lng, 100000, 'tmd_', 1) n;

  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object(
           'at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'frp', e.magnitude,
           'distance_m', round(ST_Distance(e.geom, g)), 'source', e.source_id, 'props', e.props)
           order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb))
    into v_hot
    from (select * from public.events e where e.kind = 'hotspot' and e.occurred_at >= now() - interval '7 days'
            and ST_DWithin(e.geom, g, 10000) order by e.occurred_at desc limit 50) e;

  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object(
           'at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'magnitude', e.magnitude, 'title', e.title,
           'distance_km', round((ST_Distance(e.geom, g) / 1000)::numeric, 1), 'props', e.props)
           order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb))
    into v_quake
    from (select * from public.events e where e.kind = 'earthquake' and e.occurred_at >= now() - interval '30 days'
            and ST_DWithin(e.geom, g, 300000) order by e.occurred_at desc limit 20) e;

  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object(
           'at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'title', e.title,
           'distance_m', round(ST_Distance(e.geom, g)), 'props', e.props)
           order by ST_Distance(e.geom, g)) filter (where e.id is not null), '[]'::jsonb))
    into v_slide
    from (select * from public.events e where e.kind = 'landslide' and ST_DWithin(e.geom, g, 10000)
            order by e.geom <-> g limit 50) e;

  select jsonb_build_object('count', count(*)) into v_flood
    from public.events e where e.kind = 'flood' and e.occurred_at >= now() - interval '30 days' and ST_DWithin(e.geom, g, 20000);

  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object(
           'name', s.name_th, 'area', s.area_th, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta)
           order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb))
    into v_wells
    from (select * from public.stations s where s.source_id = 'dgr_wells' and s.active and ST_DWithin(s.geom, g, 5000)
            order by s.geom <-> g limit 20) s;

  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object(
           'name', s.name_th, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta)
           order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb))
    into v_dams
    from (select * from public.stations s where s.source_id = 'dwr_dam' and s.active and ST_DWithin(s.geom, g, 20000)
            order by s.geom <-> g limit 10) s;

  -- โรงงาน (กรมโรงงานฯ) ใน 5 กม. — พิกัดคือศูนย์กลางตำบล
  select jsonb_build_object(
           'count', (select count(*) from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000)),
           'waste_handlers', (select count(*) from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000) and (e.props->>'waste_handler')::boolean),
           'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', t.type_name, 'n', t.n) order by t.n desc), '[]'::jsonb)
                         from (select e.props->>'type_name' as type_name, count(*) as n from public.events e
                                where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000) group by 1 order by 2 desc limit 6) t),
           'items', (select coalesce(jsonb_agg(jsonb_build_object('name', e.title, 'type', e.props->>'type_name', 'class', e.props->>'class',
                        'hp', e.props->>'hp', 'workers', e.props->>'workers', 'tambon', e.props->>'tambon', 'amphoe', e.props->>'amphoe',
                        'waste_handler', e.props->>'waste_handler', 'distance_m', round(ST_Distance(e.geom, g))) order by ST_Distance(e.geom, g)), '[]'::jsonb)
                       from (select * from public.events e where e.source_id = 'diw_factory' and ST_DWithin(e.geom, g, 5000)
                              order by (e.props->>'waste_handler')::boolean desc nulls last, e.geom <-> g limit 15) e))
    into v_fac;

  -- โครงการ EIA/IEE (สผ.) ใน 20 กม. — พิกัดคือศูนย์กลางตำบล/อำเภอ
  select jsonb_build_object(
           'count', (select count(*) from public.events e where e.source_id = 'onep_eia' and ST_DWithin(e.geom, g, 20000)),
           'items', (select coalesce(jsonb_agg(jsonb_build_object('name', e.title, 'category', e.props->>'category', 'status', e.props->>'status',
                        'report_type', e.props->>'report_type', 'approval_date', e.props->>'approval_date', 'owner', e.props->>'owner',
                        'location', e.props->>'location', 'id', e.ext_id, 'distance_m', round(ST_Distance(e.geom, g))) order by ST_Distance(e.geom, g)), '[]'::jsonb)
                       from (select * from public.events e where e.source_id = 'onep_eia' and ST_DWithin(e.geom, g, 20000)
                              order by e.geom <-> g limit 15) e))
    into v_eia;

  select coalesce(jsonb_agg(jsonb_build_object(
           'layer_id', l.id, 'layer', l.name_th, 'feature', f.name_th, 'props', f.props) order by l.id), '[]'::jsonb)
    into v_layers
    from (select distinct i.feature_id from public.layer_features_idx i where ST_Contains(i.geom, pt)) h
    join public.layer_features f on f.id = h.feature_id
    join public.layers l on l.id = f.layer_id;

  select c.payload || jsonb_build_object('fetched_at', c.fetched_at) into v_solar
    from public.api_cache c
   where c.cache_key = 'nasa_power:' || round(p_lat::numeric, 2) || ',' || round(p_lng::numeric, 2);

  return jsonb_build_object(
    'generated_at', now(), 'lat', p_lat, 'lng', p_lng,
    'air', v_air, 'pm25_sat', v_pm25sat, 'weather', v_weather,
    'hotspots_7d_10km', v_hot, 'quakes_30d_300km', v_quake, 'landslides_10km', v_slide,
    'floods_30d_20km', v_flood, 'wells_5km', v_wells, 'dams_20km', v_dams,
    'factories_5km', v_fac, 'eia_20km', v_eia,
    'layer_hits', v_layers, 'solar_cache', v_solar);
end $$;

alter function public.site_report(double precision, double precision) set statement_timeout = '15s';
grant execute on function public.site_report(double precision, double precision) to anon, authenticated, service_role;

-- ดัชนีช่วยกรองตามแหล่ง (events 130k+ แถว: hotspot 1.5k · ดินถล่ม 56k · โรงงาน 68k)
create index if not exists idx_events_source on public.events (source_id);

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

select (public.site_report(14.018952, 100.557728)->'factories_5km'->>'count') as "โรงงานใน 5 กม. (ปทุมธานี)",
       (public.site_report(14.018952, 100.557728)->'eia_20km'->>'count')       as "EIA ใน 20 กม.";
