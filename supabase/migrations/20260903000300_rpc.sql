-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — วิวและ RPC ที่หน้าเว็บเรียก (ไฟล์ที่ 3/5)                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ทำไมต้องเป็น RPC ไม่ยิงตารางตรง
--   คำถามหลักของหน้าเว็บคือ "จุดนี้มีอะไรบ้าง" ซึ่งเป็น spatial query 6-7 ตารางพร้อมกัน
--   ถ้าให้เบราว์เซอร์ยิงทีละตารางจะช้าและตรรกะกระจาย — รวมไว้ที่ site_report() ที่เดียว
--   หน้าเว็บได้ jsonb ก้อนเดียวไปแสดง และก้อนเดียวกันนี้ถูก snapshot ลง site_assessments
--
-- ทุกฟังก์ชัน: security definer + set search_path = public, extensions
--   (PostGIS อยู่ใน extensions — ไม่ตั้ง search_path แล้ว ST_DWithin หาไม่เจอ)
--   security definer เพื่อให้ anon เรียกได้โดยไม่ต้องเปิดตารางเพิ่ม แต่ฟังก์ชัน **อ่านอย่างเดียว**
--   ยกเว้น save_assessment ที่ตรวจ auth.uid() เอง
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. วิว: สถานี + ค่าล่าสุดทุกพารามิเตอร์ (ให้แผนที่โหลดครั้งเดียว) ───────
create or replace view public.v_station_latest
with (security_invoker = true) as
select s.id, s.source_id, s.ext_id, s.name_th, s.name_en, s.area_th, s.province,
       s.station_type, s.lat, s.lng, s.meta,
       lo.latest,
       lo.observed_at
  from public.stations s
  left join lateral (
    select jsonb_object_agg(l.parameter,
             jsonb_build_object('value', l.value, 'unit', l.unit, 'at', l.observed_at) || l.extra) as latest,
           max(l.observed_at) as observed_at
      from public.latest_observations l
     where l.station_id = s.id
  ) lo on true
 where s.active;

comment on view public.v_station_latest is 'สถานีทุกแหล่ง + ค่าล่าสุดเป็น jsonb {PM25:{value,unit,at,...}} — หน้าเว็บกรองด้วย source_id';

-- ── 2. วิว: เหตุการณ์ 30 วันล่าสุด ─────────────────────────────────────────
create or replace view public.v_recent_events
with (security_invoker = true) as
select e.id, e.source_id, e.kind, e.occurred_at, e.lat, e.lng, e.magnitude, e.title, e.province, e.props,
       e.imported_manually
  from public.events e
 where e.occurred_at >= now() - interval '30 days';

-- ── 3. สถานีใกล้จุด ──────────────────────────────────────────────────────────
create or replace function public.nearest_stations(
  p_lat double precision, p_lng double precision,
  p_radius_m int default 50000, p_source text default null, p_limit int default 10)
returns table (
  station_id bigint, source_id text, ext_id text, name_th text, area_th text, province text,
  lat double precision, lng double precision, distance_m double precision, latest jsonb, observed_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  with pt as (select ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography g)
  select s.id, s.source_id, s.ext_id, s.name_th, s.area_th, s.province, s.lat, s.lng,
         ST_Distance(s.geom, pt.g) as distance_m,
         lo.latest, lo.observed_at
    from public.stations s, pt
    left join lateral (
      select jsonb_object_agg(l.parameter,
               jsonb_build_object('value', l.value, 'unit', l.unit, 'at', l.observed_at) || l.extra) as latest,
             max(l.observed_at) as observed_at
        from public.latest_observations l where l.station_id = s.id
    ) lo on true
   where s.active
     and (p_source is null or s.source_id = p_source or s.source_id like p_source || '%')
     and ST_DWithin(s.geom, pt.g, p_radius_m)
   order by s.geom <-> pt.g
   limit greatest(1, least(p_limit, 200));
$$;

-- ── 4. ฟีเจอร์ของชั้นโพลิกอนใน bbox (GeoJSON FeatureCollection) ──────────────
--   จำกัด 2,000 ฟีเจอร์ต่อคำขอ — landuse ทั้งจังหวัดมีเป็นแสน ต้องซูมก่อน
--   simplify ตาม p_tolerance (องศา) — LDD เป็น CC BY-NC-ND ห้ามดัดแปลง ให้ส่ง 0 เสมอสำหรับชั้นนั้น
create or replace function public.layer_features_bbox(
  p_layer text,
  p_minx double precision, p_miny double precision,
  p_maxx double precision, p_maxy double precision,
  p_tolerance double precision default 0, p_limit int default 2000)
returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'layer', p_layer,
    'truncated', (select count(*) > least(p_limit, 5000) from public.layer_features f
                   where f.layer_id = p_layer
                     and f.geom && ST_MakeEnvelope(p_minx, p_miny, p_maxx, p_maxy, 4326)),
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'id', f.id,
      'properties', f.props || jsonb_build_object('name_th', f.name_th, 'ext_id', f.ext_id),
      'geometry', ST_AsGeoJSON(
        case when p_tolerance > 0 then ST_SimplifyPreserveTopology(f.geom, p_tolerance) else f.geom end, 6)::jsonb
    )), '[]'::jsonb))
  from (
    select * from public.layer_features f
     where f.layer_id = p_layer
       and f.geom && ST_MakeEnvelope(p_minx, p_miny, p_maxx, p_maxy, 4326)
     limit least(p_limit, 5000)
  ) f;
$$;

-- ── 5. รายงานจุด — หัวใจของระบบ ─────────────────────────────────────────────
--   คืน jsonb ก้อนเดียว หน้าเว็บแสดงตามหมวด และ snapshot ลง site_assessments
--   ทุกหมวดคืน null/[] ได้ถ้ายังไม่มีข้อมูล (เฟสที่ยังไม่ทำ) — หน้าเว็บต้องรองรับ
create or replace function public.site_report(p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  pt geometry  := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_air jsonb; v_pm25sat jsonb; v_weather jsonb; v_hot jsonb; v_quake jsonb;
  v_slide jsonb; v_wells jsonb; v_layers jsonb; v_solar jsonb; v_flood jsonb;
begin
  -- คุณภาพอากาศ: สถานี Air4Thai ใกล้สุดใน 50 กม.
  select to_jsonb(n) into v_air
    from public.nearest_stations(p_lat, p_lng, 50000, 'air4thai', 1) n;

  -- ฝุ่นดาวเทียม GISTDA (ระดับจังหวัด/ตำบล ถ้ามี) ใกล้สุดใน 30 กม.
  select to_jsonb(n) into v_pm25sat
    from public.nearest_stations(p_lat, p_lng, 30000, 'gistda_pm25', 1) n;

  -- สภาพอากาศ: สถานีอุตุใกล้สุดใน 100 กม. (เฟส 4)
  select to_jsonb(n) into v_weather
    from public.nearest_stations(p_lat, p_lng, 100000, 'tmd_', 1) n;

  -- จุดความร้อน 7 วัน ใน 10 กม.
  select jsonb_build_object(
           'count', count(*),
           'items', coalesce(jsonb_agg(jsonb_build_object(
              'at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'frp', e.magnitude,
              'distance_m', round(ST_Distance(e.geom, g)), 'source', e.source_id, 'props', e.props)
              order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb))
    into v_hot
    from (select * from public.events e
           where e.kind = 'hotspot' and e.occurred_at >= now() - interval '7 days'
             and ST_DWithin(e.geom, g, 10000)
           order by e.occurred_at desc limit 50) e;

  -- แผ่นดินไหว 30 วัน ใน 300 กม.
  select jsonb_build_object(
           'count', count(*),
           'items', coalesce(jsonb_agg(jsonb_build_object(
              'at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'magnitude', e.magnitude, 'title', e.title,
              'distance_km', round((ST_Distance(e.geom, g) / 1000)::numeric, 1), 'props', e.props)
              order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb))
    into v_quake
    from (select * from public.events e
           where e.kind = 'earthquake' and e.occurred_at >= now() - interval '30 days'
             and ST_DWithin(e.geom, g, 300000)
           order by e.occurred_at desc limit 20) e;

  -- ดินถล่ม (ประวัติทั้งหมด) ใน 10 กม.
  select jsonb_build_object(
           'count', count(*),
           'items', coalesce(jsonb_agg(jsonb_build_object(
              'at', e.occurred_at, 'lat', e.lat, 'lng', e.lng, 'title', e.title,
              'distance_m', round(ST_Distance(e.geom, g)), 'props', e.props)
              order by e.occurred_at desc) filter (where e.id is not null), '[]'::jsonb))
    into v_slide
    from (select * from public.events e
           where e.kind = 'landslide' and ST_DWithin(e.geom, g, 10000)
           order by e.occurred_at desc limit 50) e;

  -- น้ำท่วม (เหตุการณ์/แจ้งเตือน 30 วัน ใน 20 กม.) — เฟส 5
  select jsonb_build_object('count', count(*))
    into v_flood
    from public.events e
   where e.kind = 'flood' and e.occurred_at >= now() - interval '30 days'
     and ST_DWithin(e.geom, g, 20000);

  -- บ่อบาดาล ใน 5 กม. (เฟส 2)
  select jsonb_build_object(
           'count', count(*),
           'items', coalesce(jsonb_agg(jsonb_build_object(
              'name', s.name_th, 'area', s.area_th, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta)
              order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb))
    into v_wells
    from (select * from public.stations s
           where s.source_id = 'dgr_wells' and s.active and ST_DWithin(s.geom, g, 5000)
           order by s.geom <-> g limit 20) s;

  -- จุดตกในโพลิกอนชั้นไหนบ้าง (ป่าสงวน / ลุ่มน้ำ / อุทยาน / การใช้ที่ดิน)
  select coalesce(jsonb_agg(jsonb_build_object(
           'layer_id', l.id, 'layer', l.name_th, 'feature', f.name_th, 'props', f.props)), '[]'::jsonb)
    into v_layers
    from public.layer_features f
    join public.layers l on l.id = f.layer_id
   where ST_Contains(f.geom, pt);

  -- แคชแสงอาทิตย์ (เบราว์เซอร์เป็นคนเติม) ปัดพิกัด 2 ตำแหน่ง
  select c.payload || jsonb_build_object('fetched_at', c.fetched_at) into v_solar
    from public.api_cache c
   where c.cache_key = 'nasa_power:' || round(p_lat::numeric, 2) || ',' || round(p_lng::numeric, 2);

  return jsonb_build_object(
    'generated_at', now(),
    'lat', p_lat, 'lng', p_lng,
    'air', v_air,
    'pm25_sat', v_pm25sat,
    'weather', v_weather,
    'hotspots_7d_10km', v_hot,
    'quakes_30d_300km', v_quake,
    'landslides_10km', v_slide,
    'floods_30d_20km', v_flood,
    'wells_5km', v_wells,
    'layer_hits', v_layers,
    'solar_cache', v_solar
  );
end $$;

-- ── 6. บันทึกผลวิเคราะห์ (ต้องล็อกอิน) ─────────────────────────────────────
create or replace function public.save_assessment(
  p_name text, p_lat double precision, p_lng double precision,
  p_report jsonb, p_ref_note text default null)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนบันทึก' using errcode = '42501';
  end if;
  insert into public.site_assessments (created_by, name, lat, lng, report, ref_note)
  values (auth.uid(), coalesce(nullif(trim(p_name), ''), 'จุดวิเคราะห์ ' || to_char(now() at time zone 'Asia/Bangkok', 'DD/MM HH24:MI')),
          p_lat, p_lng, p_report, p_ref_note)
  returning id into v_id;
  return v_id;
end $$;

-- ── 7. งานประจำ (cron เรียก — ไม่เปิดให้เบราว์เซอร์) ─────────────────────────
-- สรุปรายวันของวันที่กำหนด (ค่าเริ่มต้น = เมื่อวานตามเวลาไทย) — รันซ้ำได้ (upsert)
create or replace function public.rollup_daily(p_day date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_day, ((now() at time zone 'Asia/Bangkok')::date - 1)); n int;
begin
  insert into public.observations_daily (station_id, day, parameter, value_min, value_avg, value_max, n, unit)
  select o.station_id, d, o.parameter,
         min(o.value), avg(o.value), max(o.value), count(o.value), max(o.unit)
    from public.observations o
   where o.value is not null
     and (o.observed_at at time zone 'Asia/Bangkok')::date = d
   group by o.station_id, o.parameter
  on conflict (station_id, parameter, day) do update
     set value_min = excluded.value_min, value_avg = excluded.value_avg,
         value_max = excluded.value_max, n = excluded.n, unit = excluded.unit;
  get diagnostics n = row_count;
  return n;
end $$;

-- ลบรายชั่วโมงที่เก่ากว่า p_keep_days (ค่าเริ่มต้น 180 วัน) — รายวันยังอยู่
create or replace function public.purge_old_observations(p_keep_days int default 180)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  delete from public.observations where observed_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  delete from public.api_cache where fetched_at < now() - interval '90 days';
  return n;
end $$;

-- ── 8. สิทธิ์เรียกฟังก์ชัน ───────────────────────────────────────────────────
--   ⚠️ ต้อง revoke จาก **public** และจาก **anon/authenticated/service_role** ด้วย
--   Postgres ให้ EXECUTE กับ PUBLIC ทุกครั้งที่สร้างฟังก์ชัน และ Supabase ตั้ง default privileges
--   ให้ anon/authenticated/service_role ได้ EXECUTE โดยตรงอีกชั้น — revoke จาก public อย่างเดียว
--   anon ยังเรียก purge_old_observations() ได้ (เจอจริงตอนติดตั้ง 3 ก.ย. 2569)
do $$
declare f text;
begin
  foreach f in array array[
    'public.nearest_stations(double precision,double precision,int,text,int)',
    'public.layer_features_bbox(text,double precision,double precision,double precision,double precision,double precision,int)',
    'public.site_report(double precision,double precision)',
    'public.save_assessment(text,double precision,double precision,jsonb,text)',
    'public.rollup_daily(date)',
    'public.purge_old_observations(int)',
    'public.app_role()', 'public.is_admin()', 'public.can_import()',
    'public.touch_updated_at()', 'public.handle_new_user()'
  ] loop
    begin
      execute format('revoke execute on function %s from public, anon, authenticated, service_role', f);
    exception when others then raise warning 'revoke % : %', f, sqlerrm; end;
  end loop;

  -- อ่านอย่างเดียว → anon + authenticated
  foreach f in array array[
    'public.nearest_stations(double precision,double precision,int,text,int)',
    'public.layer_features_bbox(text,double precision,double precision,double precision,double precision,double precision,int)',
    'public.site_report(double precision,double precision)'
  ] loop
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;

  -- ต้องล็อกอิน
  execute 'grant execute on function public.save_assessment(text,double precision,double precision,jsonb,text) to authenticated, service_role';
  execute 'grant execute on function public.app_role() to authenticated, service_role';
  execute 'grant execute on function public.is_admin() to authenticated, service_role';
  execute 'grant execute on function public.can_import() to authenticated, service_role';

  -- งานประจำ → service_role เท่านั้น (cron รันเป็น postgres อยู่แล้ว)
  execute 'grant execute on function public.rollup_daily(date) to service_role';
  execute 'grant execute on function public.purge_old_observations(int) to service_role';
end $$;

grant select on public.v_station_latest, public.v_recent_events to anon, authenticated, service_role;

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

-- ── ตรวจผล ──────────────────────────────────────────────────────────────────
select p.proname as "ฟังก์ชัน",
       has_function_privilege('anon', p.oid, 'execute')          as "anon",
       has_function_privilege('authenticated', p.oid, 'execute') as "authenticated"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('nearest_stations','layer_features_bbox','site_report','save_assessment',
                     'rollup_daily','purge_old_observations','app_role','is_admin','can_import')
 order by 1;
