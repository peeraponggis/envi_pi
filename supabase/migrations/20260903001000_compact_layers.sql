-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — ลดขนาดฐานข้อมูล: เก็บโพลิกอนแบบแบ่งชิ้นสำเนาเดียว (ไฟล์เสริม 10)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ทำไม (3 ก.ย. 2569 ค่ำ): ฐานข้อมูล 537 MB เกิน 500 MB ของแผน Free (Dashboard ขึ้น EXCEEDING USAGE LIMITS)
--   layer_features_idx 189 MB (ชิ้นย่อย 66,539) + layer_features 140 MB (ต้นฉบับ toast 110 MB) = เก็บรูปเดียวกันสองสำเนา
--   events 123 MB (โรงงาน 68k แถวมี props ข้อความยาว: activity/type_name/old_reg)
--
-- ทำอะไร
--   1. layer_features → เก็บ "ชิ้นย่อย" (ST_Subdivide 256 จุดยอด) แทนต้นฉบับ หลายแถวต่อฟีเจอร์ ผูกกันด้วย (layer_id, ext_id, name_th)
--      → ST_Contains เร็วเหมือนเดิม ไม่ต้องมีตารางดัชนีแยก · การแสดงผล (layer_features_bbox) ได้ชิ้นย่อยซึ่งต่อกันสนิท
--   2. ลบตาราง layer_features_idx และ trigger · import_features / replace_layer_features แบ่งชิ้นตอน insert
--   3. site_report / layer_features_bbox นับฟีเจอร์ด้วย distinct (layer_id, ext_id, name_th)
--   4. ตัด props ซ้ำซ้อนของโรงงาน (activity, old_reg, capital_mb, year_be, geocode) — เก็บใน CSV ต้นทางแล้ว
--   ⚠️ หลังรันไฟล์นี้ ต้องรัน VACUUM FULL แยกอีกครั้ง (อยู่ท้ายไฟล์ เป็นคำสั่งเดี่ยว) ไม่งั้นพื้นที่ยังไม่คืน
--
-- รันซ้ำได้ (ตรวจว่าตาราง idx ยังอยู่ก่อนย้าย)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ย้ายชิ้นย่อยมาเป็น layer_features (ครั้งเดียว) ───────────────────────
do $$
begin
  if to_regclass('public.layer_features_idx') is null then
    raise notice 'ไม่มี layer_features_idx — ย้ายไปแล้ว ข้าม';
    return;
  end if;

  drop trigger if exists trg_lf_index on public.layer_features;

  create table public.layer_features_pieces (
    id        bigint generated always as identity primary key,
    layer_id  text not null references public.layers(id) on delete cascade,
    ext_id    text,
    name_th   text,
    props     jsonb not null default '{}'::jsonb,
    geom      extensions.geometry(Geometry, 4326) not null
  );
  -- ชิ้นย่อยจาก idx + props/ชื่อจากต้นฉบับ
  insert into public.layer_features_pieces (layer_id, ext_id, name_th, props, geom)
  select i.layer_id, f.ext_id, f.name_th, f.props, i.geom
    from public.layer_features_idx i
    join public.layer_features f on f.id = i.feature_id;
  -- ฟีเจอร์ที่ไม่มีชิ้นย่อย (เช่น จุด/เส้น หรือชั้นที่ยังไม่ได้ index) เก็บต้นฉบับไว้
  insert into public.layer_features_pieces (layer_id, ext_id, name_th, props, geom)
  select f.layer_id, f.ext_id, f.name_th, f.props, f.geom
    from public.layer_features f
   where not exists (select 1 from public.layer_features_idx i where i.feature_id = f.id);

  drop table public.layer_features_idx;
  drop table public.layer_features;
  alter table public.layer_features_pieces rename to layer_features;
  alter index layer_features_pieces_pkey rename to layer_features_pkey;
  raise notice 'ย้ายชิ้นย่อยเป็น layer_features แล้ว';
end $$;

create index if not exists idx_lf_geom  on public.layer_features using gist (geom);
create index if not exists idx_lf_layer on public.layer_features (layer_id);
create index if not exists idx_lf_key   on public.layer_features (layer_id, ext_id, name_th);

alter table public.layer_features enable row level security;
drop policy if exists p_layer_features_anon_read on public.layer_features;
drop policy if exists p_layer_features_auth_read on public.layer_features;
drop policy if exists p_layer_features_import_write on public.layer_features;
create policy p_layer_features_anon_read on public.layer_features for select to anon using (true);
create policy p_layer_features_auth_read on public.layer_features for select to authenticated using (true);
create policy p_layer_features_import_write on public.layer_features for all to authenticated using (public.can_import()) with check (public.can_import());
grant select on public.layer_features to anon;
grant select, insert, update, delete on public.layer_features to authenticated;
grant all on public.layer_features to service_role;

-- ── 2. ฟังก์ชันแบ่งชิ้นตอนนำเข้า ──────────────────────────────────────────
create or replace function public.insert_layer_feature(p_layer text, p_ext_id text, p_name text, p_props jsonb, p_geom geometry)
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare g geometry := p_geom; n int;
begin
  if not ST_IsValid(g) then g := ST_MakeValid(g); end if;
  if ST_Dimension(g) = 2 then
    insert into public.layer_features (layer_id, ext_id, name_th, props, geom)
    select p_layer, p_ext_id, p_name, coalesce(p_props, '{}'::jsonb), ST_Subdivide(ST_CollectionExtract(g, 3), 256);
  else
    insert into public.layer_features (layer_id, ext_id, name_th, props, geom) values (p_layer, p_ext_id, p_name, coalesce(p_props, '{}'::jsonb), g);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.import_features(
  p_layer text, p_features jsonb, p_name_key text default 'name', p_ext_key text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb; n_ok int := 0; n_bad int := 0; errs text[] := '{}';
begin
  if not public.can_import() then raise exception 'ต้องเป็น admin หรือ editor' using errcode = '42501'; end if;
  if not exists (select 1 from public.layers where id = p_layer) then raise exception 'ไม่มีชั้น % — สร้างใน layers ก่อน', p_layer; end if;
  for f in select * from jsonb_array_elements(p_features) loop
    begin
      perform public.insert_layer_feature(p_layer,
        case when p_ext_key is not null then f->'properties'->>p_ext_key else null end,
        f->'properties'->>p_name_key, f->'properties',
        ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326));
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;
      if array_length(errs, 1) is null or array_length(errs, 1) < 5 then errs := errs || sqlerrm; end if;
    end;
  end loop;
  update public.layers
     set feature_count = (select count(distinct (ext_id, name_th)) from public.layer_features where layer_id = p_layer),
         loaded_at = now(), loaded_by = auth.uid()
   where id = p_layer;
  return jsonb_build_object('inserted', n_ok, 'skipped', n_bad, 'errors', to_jsonb(errs));
end $$;

create or replace function public.replace_layer_features(
  p_layer text, p_features jsonb, p_name_key text default 'name', p_ext_key text default null,
  p_layer_row jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb; n_ok int := 0; n_bad int := 0; errs text[] := '{}';
begin
  insert into public.layers (id, source_id, name_th, geom_type, style, notes)
  values (p_layer, p_layer_row->>'source_id', coalesce(p_layer_row->>'name_th', p_layer), 'MultiPolygon',
          coalesce(p_layer_row->'style', '{}'::jsonb), p_layer_row->>'notes')
  on conflict (id) do update
     set name_th = coalesce(excluded.name_th, public.layers.name_th),
         source_id = coalesce(excluded.source_id, public.layers.source_id),
         style = case when excluded.style = '{}'::jsonb then public.layers.style else excluded.style end,
         notes = coalesce(excluded.notes, public.layers.notes);
  delete from public.layer_features where layer_id = p_layer;
  for f in select * from jsonb_array_elements(coalesce(p_features, '[]'::jsonb)) loop
    begin
      perform public.insert_layer_feature(p_layer,
        case when p_ext_key is not null then f->'properties'->>p_ext_key else null end,
        f->'properties'->>p_name_key, f->'properties',
        ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326));
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;
      if array_length(errs, 1) is null or array_length(errs, 1) < 5 then errs := errs || sqlerrm; end if;
    end;
  end loop;
  update public.layers set feature_count = n_ok, loaded_at = now() where id = p_layer;
  return jsonb_build_object('inserted', n_ok, 'skipped', n_bad, 'errors', to_jsonb(errs));
end $$;

drop function if exists public.rebuild_layer_index(text);
drop function if exists public.index_layer_feature(bigint);
drop function if exists public.trg_layer_feature_index();

-- ── 3. layer_features_bbox / site_report ใช้ชิ้นย่อยโดยตรง ─────────────────
create or replace function public.layer_features_bbox(
  p_layer text, p_minx double precision, p_miny double precision, p_maxx double precision, p_maxy double precision,
  p_tolerance double precision default 0, p_limit int default 2000)
returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'type', 'FeatureCollection', 'layer', p_layer,
    'truncated', (select count(*) > least(p_limit, 5000) from public.layer_features f
                   where f.layer_id = p_layer and f.geom && ST_MakeEnvelope(p_minx, p_miny, p_maxx, p_maxy, 4326)),
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature', 'id', f.id,
      'properties', f.props || jsonb_build_object('name_th', f.name_th, 'ext_id', f.ext_id),
      'geometry', ST_AsGeoJSON(case when p_tolerance > 0 then ST_SimplifyPreserveTopology(f.geom, p_tolerance) else f.geom end, 6)::jsonb)), '[]'::jsonb))
  from (select * from public.layer_features f
         where f.layer_id = p_layer and f.geom && ST_MakeEnvelope(p_minx, p_miny, p_maxx, p_maxy, 4326)
         limit least(p_limit, 5000)) f;
$$;

-- site_report: เหมือนไฟล์ 9 ทุกอย่าง เปลี่ยนเฉพาะบล็อก layer_hits (ไม่มีตาราง idx แล้ว)
create or replace function public.site_report(p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  pt geometry  := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_air jsonb; v_pm25sat jsonb; v_weather jsonb; v_hot jsonb; v_quake jsonb;
  v_slide jsonb; v_wells jsonb; v_layers jsonb; v_solar jsonb; v_flood jsonb; v_dams jsonb; v_fac jsonb; v_eia jsonb;
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
  -- จุดตกในโพลิกอน: ชิ้นย่อยหลายชิ้นต่อฟีเจอร์ → distinct ตาม (layer, ext_id, name)
  select coalesce(jsonb_agg(jsonb_build_object('layer_id', h.layer_id, 'layer', l.name_th, 'feature', h.name_th, 'props', h.props) order by h.layer_id), '[]'::jsonb)
    into v_layers
    from (select distinct on (f.layer_id, f.ext_id, f.name_th) f.layer_id, f.ext_id, f.name_th, f.props
            from public.layer_features f where ST_Contains(f.geom, pt)) h
    join public.layers l on l.id = h.layer_id;
  select c.payload || jsonb_build_object('fetched_at', c.fetched_at) into v_solar from public.api_cache c
   where c.cache_key = 'nasa_power:' || round(p_lat::numeric, 2) || ',' || round(p_lng::numeric, 2);
  return jsonb_build_object('generated_at', now(), 'lat', p_lat, 'lng', p_lng, 'air', v_air, 'pm25_sat', v_pm25sat, 'weather', v_weather,
    'hotspots_7d_10km', v_hot, 'quakes_30d_300km', v_quake, 'landslides_10km', v_slide, 'floods_30d_20km', v_flood, 'wells_5km', v_wells,
    'dams_20km', v_dams, 'factories_5km', v_fac, 'eia_20km', v_eia, 'layer_hits', v_layers, 'solar_cache', v_solar);
end $$;

-- ── 4. ตัด props ซ้ำซ้อนของโรงงาน ──────────────────────────────────────────
update public.events
   set props = props - 'activity' - 'old_reg' - 'capital_mb' - 'year_be' - 'geocode'
 where source_id = 'diw_factory' and props ? 'activity';

-- ── สิทธิ์ ──────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['public.insert_layer_feature(text,text,text,jsonb,geometry)', 'public.import_features(text,jsonb,text,text)',
    'public.replace_layer_features(text,jsonb,text,text,jsonb)', 'public.layer_features_bbox(text,double precision,double precision,double precision,double precision,double precision,int)',
    'public.site_report(double precision,double precision)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f);
  end loop;
  execute 'grant execute on function public.import_features(text,jsonb,text,text) to authenticated, service_role';
  execute 'grant execute on function public.replace_layer_features(text,jsonb,text,text,jsonb) to service_role';
  execute 'grant execute on function public.layer_features_bbox(text,double precision,double precision,double precision,double precision,double precision,int) to anon, authenticated, service_role';
  execute 'grant execute on function public.site_report(double precision,double precision) to anon, authenticated, service_role';
end $$;
alter function public.site_report(double precision, double precision) set statement_timeout = '15s';
alter function public.import_features(text, jsonb, text, text) set statement_timeout = '120s';
alter function public.replace_layer_features(text, jsonb, text, text, jsonb) set statement_timeout = '120s';

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

select l.id, l.feature_count as "ฟีเจอร์ (layers)", (select count(*) from public.layer_features f where f.layer_id = l.id) as "ชิ้นย่อย"
  from public.layers l order by 1;

-- ═══ หลังไฟล์นี้ รัน **แยกทีละคำสั่ง** (VACUUM FULL ใช้ใน transaction ไม่ได้) ═══
-- vacuum full public.layer_features;
-- vacuum full public.events;
-- vacuum full public.stations;
-- select pg_size_pretty(pg_database_size(current_database()));
