-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — RPC นำเข้าไฟล์นิ่งจากหน้า import.html (ไฟล์เสริม)                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ทำไมไม่ให้เบราว์เซอร์ insert ตรง
--   geom ต้องผ่าน ST_GeomFromGeoJSON + ST_SetSRID + ST_Multi และตรวจ ST_IsValid
--   ถ้าปล่อยให้ยิงตรง PostgREST จะยอมรับ GeoJSON ก็จริง แต่ SRID/ชนิดจะเพี้ยนเงียบ ๆ
--   รวมไว้ที่ RPC เดียว รายงานกลับว่า **เข้ากี่แถว ข้ามกี่แถว เพราะอะไร** ไม่ใช่ ok/ไม่ ok
--
-- ทุกฟังก์ชันตรวจ can_import() เอง (admin/editor) — anon/viewer เรียกแล้วได้ 42501
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ชั้นโพลิกอน: รับ GeoJSON features (array) ─────────────────────────────
create or replace function public.import_features(
  p_layer text, p_features jsonb, p_name_key text default 'name', p_ext_key text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  f jsonb; g geometry; n_ok int := 0; n_bad int := 0; errs text[] := '{}';
begin
  if not public.can_import() then
    raise exception 'ต้องเป็น admin หรือ editor' using errcode = '42501';
  end if;
  if not exists (select 1 from public.layers where id = p_layer) then
    raise exception 'ไม่มีชั้น % — สร้างใน layers ก่อน', p_layer;
  end if;

  for f in select * from jsonb_array_elements(p_features) loop
    begin
      g := ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326);
      if not ST_IsValid(g) then g := ST_MakeValid(g); end if;
      if GeometryType(g) in ('POLYGON','MULTIPOLYGON') then g := ST_Multi(g); end if;
      insert into public.layer_features (layer_id, ext_id, name_th, props, geom)
      values (p_layer,
              case when p_ext_key is not null then f->'properties'->>p_ext_key else null end,
              f->'properties'->>p_name_key,
              coalesce(f->'properties', '{}'::jsonb),
              g);
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;
      if array_length(errs, 1) is null or array_length(errs, 1) < 5 then errs := errs || sqlerrm; end if;
    end;
  end loop;

  update public.layers
     set feature_count = (select count(*) from public.layer_features where layer_id = p_layer),
         loaded_at = now(), loaded_by = auth.uid()
   where id = p_layer;

  return jsonb_build_object('inserted', n_ok, 'skipped', n_bad, 'errors', to_jsonb(errs));
end $$;

-- ── 2. เหตุการณ์จุด (ดินถล่ม DMR, EIA, ฯลฯ) ──────────────────────────────────
--   p_rows = [{ext_id, occurred_at, lat, lng, magnitude?, title?, province?, props?}]
create or replace function public.import_events(p_source text, p_kind event_kind, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  r jsonb; n_ok int := 0; n_bad int := 0; errs text[] := '{}';
begin
  if not public.can_import() then
    raise exception 'ต้องเป็น admin หรือ editor' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sources where id = p_source) then
    raise exception 'ไม่มีแหล่ง % ใน sources', p_source;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      if (r->>'lat') is null or (r->>'lng') is null then raise exception 'ไม่มีพิกัด'; end if;
      insert into public.events (source_id, kind, ext_id, occurred_at, lat, lng, magnitude, title, province, props, imported_manually)
      values (p_source, p_kind,
              coalesce(r->>'ext_id', md5(coalesce(r->>'lat','') || '|' || coalesce(r->>'lng','') || '|' || coalesce(r->>'occurred_at',''))),
              coalesce((r->>'occurred_at')::timestamptz, '1970-01-01'::timestamptz),
              (r->>'lat')::double precision, (r->>'lng')::double precision,
              (r->>'magnitude')::double precision, r->>'title', r->>'province',
              coalesce(r->'props', '{}'::jsonb), true)
      on conflict (source_id, ext_id) do update
         set occurred_at = excluded.occurred_at, lat = excluded.lat, lng = excluded.lng,
             magnitude = excluded.magnitude, title = excluded.title, province = excluded.province,
             props = excluded.props;
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;
      if array_length(errs, 1) is null or array_length(errs, 1) < 5 then errs := errs || sqlerrm; end if;
    end;
  end loop;
  return jsonb_build_object('inserted', n_ok, 'skipped', n_bad, 'errors', to_jsonb(errs));
end $$;

-- ── 3. สถานี/จุดตรวจวัด (DEDE 38 สถานี, ตำบล centroid ฯลฯ) ──────────────────
--   p_rows = [{ext_id, name_th, name_en?, area_th?, province?, station_type?, lat, lng, meta?}]
create or replace function public.import_stations(p_source text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  r jsonb; n_ok int := 0; n_bad int := 0; errs text[] := '{}';
begin
  if not public.can_import() then
    raise exception 'ต้องเป็น admin หรือ editor' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sources where id = p_source) then
    raise exception 'ไม่มีแหล่ง % ใน sources', p_source;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      insert into public.stations (source_id, ext_id, name_th, name_en, area_th, province, station_type, lat, lng, meta)
      values (p_source, coalesce(r->>'ext_id', r->>'name_th'), r->>'name_th', r->>'name_en', r->>'area_th',
              r->>'province', r->>'station_type',
              (r->>'lat')::double precision, (r->>'lng')::double precision,
              coalesce(r->'meta', '{}'::jsonb))
      on conflict (source_id, ext_id) do update
         set name_th = excluded.name_th, name_en = excluded.name_en, area_th = excluded.area_th,
             province = excluded.province, station_type = excluded.station_type,
             lat = excluded.lat, lng = excluded.lng, meta = public.stations.meta || excluded.meta, active = true;
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;
      if array_length(errs, 1) is null or array_length(errs, 1) < 5 then errs := errs || sqlerrm; end if;
    end;
  end loop;
  return jsonb_build_object('inserted', n_ok, 'skipped', n_bad, 'errors', to_jsonb(errs));
end $$;

-- ── สิทธิ์ ──────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'public.import_features(text,jsonb,text,text)',
    'public.import_events(text,event_kind,jsonb)',
    'public.import_stations(text,jsonb)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

select p.proname as "ฟังก์ชัน", has_function_privilege('authenticated', p.oid, 'execute') as "authenticated",
       has_function_privilege('anon', p.oid, 'execute') as "anon (ต้อง false)"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'import_%' order by 1;
