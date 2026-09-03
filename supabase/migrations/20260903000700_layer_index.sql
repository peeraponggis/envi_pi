-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — ดัชนีโพลิกอนย่อยสำหรับ point-in-polygon (ไฟล์เสริม 7)             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ทำไม (เจอจริง 3 ก.ย. 2569 หลังนำเข้าลุ่มน้ำหลัก/แรมซาร์จาก DWR)
--   site_report() ตรวจ ST_Contains(f.geom, จุด) กับ layer_features ตรง ๆ
--   โพลิกอนลุ่มน้ำหลักหนึ่งแปลงมีจุดยอดหลายแสนจุด GiST กรองด้วย bbox ได้แค่ระดับหยาบ
--   แล้วต้องคำนวณ ST_Contains กับรูปยักษ์ทุกรูปที่ bbox ครอบจุด → 57014 statement timeout
--   วิธีมาตรฐาน PostGIS: ST_Subdivide แบ่งแต่ละโพลิกอนเป็นชิ้นเล็ก ≤ 256 จุดยอด
--   เก็บในตารางดัชนี → ST_Contains กับชิ้นเล็กเร็วระดับมิลลิวินาที
--
-- โครง
--   layer_features_idx (feature_id, layer_id, geom) — ชิ้นย่อย · trigger เติมให้อัตโนมัติเมื่อ insert/update/delete
--   rebuild_layer_index(p_layer) — สร้างใหม่ทั้งชั้น (ใช้ครั้งแรกกับข้อมูลที่นำเข้าไปแล้ว)
--   site_report() ใช้ตารางดัชนี · layer_features (ต้นฉบับ) ยังใช้แสดงผล/bbox ตามเดิม
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.layer_features_idx (
  id          bigint generated always as identity primary key,
  feature_id  bigint not null references public.layer_features(id) on delete cascade,
  layer_id    text not null references public.layers(id) on delete cascade,
  geom        extensions.geometry(Geometry, 4326) not null
);
create index if not exists idx_lfi_geom    on public.layer_features_idx using gist (geom);
create index if not exists idx_lfi_feature on public.layer_features_idx (feature_id);
create index if not exists idx_lfi_layer   on public.layer_features_idx (layer_id);  -- นับ/กรองตามชั้น (ไม่มีแล้ว count เกิน 3 วิ)

alter table public.layer_features_idx enable row level security;
drop policy if exists p_lfi_anon_read on public.layer_features_idx;
drop policy if exists p_lfi_auth_read on public.layer_features_idx;
create policy p_lfi_anon_read on public.layer_features_idx for select to anon using (true);
create policy p_lfi_auth_read on public.layer_features_idx for select to authenticated using (true);
grant select on public.layer_features_idx to anon, authenticated;
grant all on public.layer_features_idx to service_role;

-- ── แบ่งหนึ่งฟีเจอร์ ───────────────────────────────────────────────────────
create or replace function public.index_layer_feature(p_feature_id bigint)
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  delete from public.layer_features_idx where feature_id = p_feature_id;
  insert into public.layer_features_idx (feature_id, layer_id, geom)
  -- ST_MakeValid อาจคืน GEOMETRYCOLLECTION (โพลิกอน+เส้น+จุด) → ดึงเฉพาะส่วนที่เป็นพื้นที่ (ST_CollectionExtract …, 3)
  -- ถ้ากรองด้วย GeometryType ก่อน จะพลาดฟีเจอร์ที่ถูก MakeValid ตอนนำเข้า (เจอ: ลุ่มน้ำหลักติดดัชนีแค่ 11/28)
  select f.id, f.layer_id, ST_Subdivide(ST_CollectionExtract(ST_MakeValid(f.geom), 3), 256)
    from public.layer_features f
   where f.id = p_feature_id
     and ST_Dimension(f.geom) = 2;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── สร้างใหม่ทั้งชั้น (หรือทุกชั้นถ้า null) ─────────────────────────────────
create or replace function public.rebuild_layer_index(p_layer text default null)
returns table (layer_id text, features bigint, pieces bigint)
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.layer_features_idx i where p_layer is null or i.layer_id = p_layer;
  insert into public.layer_features_idx (feature_id, layer_id, geom)
  select f.id, f.layer_id, ST_Subdivide(ST_CollectionExtract(ST_MakeValid(f.geom), 3), 256)
    from public.layer_features f
   where (p_layer is null or f.layer_id = p_layer)
     and ST_Dimension(f.geom) = 2;
  return query
    select i.layer_id, count(distinct i.feature_id), count(*)
      from public.layer_features_idx i
     where p_layer is null or i.layer_id = p_layer
     group by i.layer_id order by i.layer_id;
end $$;

-- ── trigger: เติมดัชนีให้ทุกครั้งที่นำเข้าผ่าน import_features ───────────────
create or replace function public.trg_layer_feature_index() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'DELETE' then return old; end if;   -- on delete cascade จัดการเอง
  perform public.index_layer_feature(new.id);
  return new;
end $$;

drop trigger if exists trg_lf_index on public.layer_features;
create trigger trg_lf_index after insert or update of geom on public.layer_features
  for each row execute function public.trg_layer_feature_index();

-- ── site_report: ใช้ตารางดัชนี ─────────────────────────────────────────────
--   (นิยามเดิมอยู่ในไฟล์ 3 — ส่วนอื่นคงเดิม เปลี่ยนเฉพาะบล็อก layer_hits)
create or replace function public.site_report(p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  pt geometry  := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_air jsonb; v_pm25sat jsonb; v_weather jsonb; v_hot jsonb; v_quake jsonb;
  v_slide jsonb; v_wells jsonb; v_layers jsonb; v_solar jsonb; v_flood jsonb; v_dams jsonb;
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

  -- เขื่อน/อ่างเก็บน้ำ (DWR) ใน 20 กม.
  select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(jsonb_build_object(
           'name', s.name_th, 'distance_m', round(ST_Distance(s.geom, g)), 'meta', s.meta)
           order by ST_Distance(s.geom, g)) filter (where s.id is not null), '[]'::jsonb))
    into v_dams
    from (select * from public.stations s where s.source_id = 'dwr_dam' and s.active and ST_DWithin(s.geom, g, 20000)
            order by s.geom <-> g limit 10) s;

  -- จุดตกในโพลิกอน — ผ่านตารางดัชนีชิ้นย่อย (distinct ต่อฟีเจอร์)
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
    'layer_hits', v_layers, 'solar_cache', v_solar);
end $$;

-- เผื่อจุดที่คำนวณหนักจริง ให้เวลาเพิ่ม (ค่าเริ่มต้นของ Supabase สำหรับ anon สั้น)
alter function public.site_report(double precision, double precision) set statement_timeout = '15s';
alter function public.layer_features_bbox(text, double precision, double precision, double precision, double precision, double precision, int) set statement_timeout = '15s';
-- นำเข้าโพลิกอนยักษ์ (แรมซาร์บางแปลงหลายแสนจุดยอด + ST_IsValid + subdivide ใน trigger) ต้องการเวลามากกว่าค่าเริ่มต้นของ authenticated
alter function public.import_features(text, jsonb, text, text) set statement_timeout = '120s';
alter function public.import_events(text, event_kind, jsonb) set statement_timeout = '120s';
alter function public.import_stations(text, jsonb) set statement_timeout = '120s';
alter function public.rebuild_layer_index(text) set statement_timeout = '600s';

-- ── สิทธิ์ ──────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['public.index_layer_feature(bigint)', 'public.rebuild_layer_index(text)', 'public.trg_layer_feature_index()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f);
  end loop;
  execute 'grant execute on function public.rebuild_layer_index(text) to service_role';
  execute 'grant execute on function public.site_report(double precision,double precision) to anon, authenticated, service_role';
end $$;

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

-- ── สร้างดัชนีให้ข้อมูลที่นำเข้าไปแล้ว (อาจใช้เวลาหลายสิบวินาที) ───────────────
select * from public.rebuild_layer_index(null);
