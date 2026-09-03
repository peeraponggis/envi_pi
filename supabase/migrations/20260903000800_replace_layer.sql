-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — RPC แทนที่ชั้นโพลิกอนทั้งชั้นจาก Edge Function (ไฟล์เสริม 8)       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ทำไม
--   ชั้นที่เปลี่ยนทุกวัน (พื้นที่น้ำท่วมจากดาวเทียม GISTDA flood1day) ต้อง "ลบทั้งชั้นแล้วใส่ใหม่"
--   import_features() ตรวจ can_import() ด้วย auth.uid() ซึ่ง service_role ของ Edge Function ไม่มี
--   → ฟังก์ชันนี้ไม่ตรวจบทบาท แต่ **เรียกได้เฉพาะ service_role** (revoke จาก anon/authenticated)
--   ใช้ตรรกะ geometry เดียวกับ import_features (GeoJSON → MakeValid → Multi) และ trigger เติมดัชนีให้เอง
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.replace_layer_features(
  p_layer text, p_features jsonb, p_name_key text default 'name', p_ext_key text default null,
  p_layer_row jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  f jsonb; g geometry; n_ok int := 0; n_bad int := 0; errs text[] := '{}';
begin
  -- สร้าง/อัปเดตแถวชั้นก่อน (name_th, source_id, style, notes มาจาก p_layer_row)
  insert into public.layers (id, source_id, name_th, geom_type, style, notes)
  values (p_layer, p_layer_row->>'source_id', coalesce(p_layer_row->>'name_th', p_layer), 'MultiPolygon',
          coalesce(p_layer_row->'style', '{}'::jsonb), p_layer_row->>'notes')
  on conflict (id) do update
     set name_th = coalesce(excluded.name_th, public.layers.name_th),
         source_id = coalesce(excluded.source_id, public.layers.source_id),
         style = case when excluded.style = '{}'::jsonb then public.layers.style else excluded.style end,
         notes = coalesce(excluded.notes, public.layers.notes);

  delete from public.layer_features where layer_id = p_layer;   -- ดัชนีย่อยลบตาม (on delete cascade)

  for f in select * from jsonb_array_elements(coalesce(p_features, '[]'::jsonb)) loop
    begin
      g := ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326);
      if not ST_IsValid(g) then g := ST_MakeValid(g); end if;
      if GeometryType(g) in ('POLYGON', 'MULTIPOLYGON') then g := ST_Multi(g); end if;
      insert into public.layer_features (layer_id, ext_id, name_th, props, geom)
      values (p_layer,
              case when p_ext_key is not null then f->'properties'->>p_ext_key else null end,
              f->'properties'->>p_name_key, coalesce(f->'properties', '{}'::jsonb), g);
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;
      if array_length(errs, 1) is null or array_length(errs, 1) < 5 then errs := errs || sqlerrm; end if;
    end;
  end loop;

  update public.layers set feature_count = n_ok, loaded_at = now() where id = p_layer;
  return jsonb_build_object('inserted', n_ok, 'skipped', n_bad, 'errors', to_jsonb(errs));
end $$;

alter function public.replace_layer_features(text, jsonb, text, text, jsonb) set statement_timeout = '120s';
revoke execute on function public.replace_layer_features(text, jsonb, text, text, jsonb) from public, anon, authenticated, service_role;
grant  execute on function public.replace_layer_features(text, jsonb, text, text, jsonb) to service_role;

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

select p.proname as "ฟังก์ชัน",
       has_function_privilege('anon', p.oid, 'execute') as "anon (ต้อง false)",
       has_function_privilege('authenticated', p.oid, 'execute') as "authenticated (ต้อง false)",
       has_function_privilege('service_role', p.oid, 'execute') as "service_role"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'replace_layer_features';
