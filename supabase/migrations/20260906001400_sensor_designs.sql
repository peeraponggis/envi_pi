-- ═══════════════════════════════════════════════════════════════════════════
-- 20260906001400_sensor_designs.sql — บันทึกแบบระบบเซนเซอร์/พลังงาน (หน้า web/sensor-design.html)
--
-- เก็บเฉพาะ input + BOQ + ผลสรุป (~5–20 KB/แบบ) ไม่เก็บอนุกรมเวลาจำลอง (เก็บ seed แทน) — DB Free ใกล้เพดาน
-- สิทธิ์: เจ้าของอ่าน/เขียน/ลบของตัวเอง · admin อ่านทั้งหมด · anon ไม่มีสิทธิ์ · เขียนผ่าน RPC save_sensor_design (security definer)
-- รันซ้ำได้ · กติกา: revoke จาก public/anon/authenticated/service_role ก่อน grant · ตรวจผลแสดงทุกแถว
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.sensor_designs (
  id               uuid primary key default gen_random_uuid(),
  created_by       uuid not null references public.profiles(id) on delete cascade,
  name             text not null,
  process_code     text not null,                 -- AS/SP/AL/OD/CW/RBC/SBR/MBR/UASB/Anaerobic/IND (ตาม sensor-catalog.js)
  capacity_m3d     numeric,
  lat              double precision,
  lng              double precision,
  station_id       bigint references public.stations(id) on delete set null,   -- โรงจริง DSPOT (ถ้าเลือก)
  design           jsonb not null default '{}'::jsonb,   -- {qs, summary{w_avg,kwh_day_sensors,kwh_day_plant,kwp_total,psh}, items[]}
  catalog_version  text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.sensor_designs is 'แบบระบบเซนเซอร์/พลังงานที่ผู้ใช้ออกแบบ — ค่าทั้งหมดเป็นค่าประมาณจาก sensor-catalog.js';
create index if not exists idx_sensor_designs_owner on public.sensor_designs (created_by, updated_at desc);

drop trigger if exists trg_sensor_designs_touch on public.sensor_designs;
create trigger trg_sensor_designs_touch before update on public.sensor_designs
  for each row execute function public.touch_updated_at();

alter table public.sensor_designs enable row level security;
drop policy if exists sensor_designs_owner_all on public.sensor_designs;
create policy sensor_designs_owner_all on public.sensor_designs
  for all to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
drop policy if exists sensor_designs_admin_read on public.sensor_designs;
create policy sensor_designs_admin_read on public.sensor_designs
  for select to authenticated using (public.is_admin());

revoke all on public.sensor_designs from public, anon;
grant select, insert, update, delete on public.sensor_designs to authenticated;
grant all on public.sensor_designs to service_role;

-- ── RPC บันทึก (สร้างใหม่หรืออัปเดตของตัวเอง) ─────────────────────────────
create or replace function public.save_sensor_design(
  p_id uuid, p_name text, p_process_code text, p_capacity numeric, p_lat double precision, p_lng double precision,
  p_station_id bigint, p_design jsonb, p_catalog_version text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'ต้องล็อกอิน'; end if;
  if p_id is null then
    insert into public.sensor_designs (created_by, name, process_code, capacity_m3d, lat, lng, station_id, design, catalog_version)
    values (auth.uid(), p_name, p_process_code, p_capacity, p_lat, p_lng, p_station_id, coalesce(p_design, '{}'::jsonb), coalesce(p_catalog_version, ''))
    returning id into v_id;
  else
    update public.sensor_designs
       set name = p_name, process_code = p_process_code, capacity_m3d = p_capacity, lat = p_lat, lng = p_lng,
           station_id = p_station_id, design = coalesce(p_design, '{}'::jsonb), catalog_version = coalesce(p_catalog_version, '')
     where id = p_id and created_by = auth.uid()
    returning id into v_id;
    if v_id is null then raise exception 'ไม่พบแบบหรือไม่ใช่เจ้าของ'; end if;
  end if;
  return v_id;
end $$;

revoke execute on function public.save_sensor_design(uuid, text, text, numeric, double precision, double precision, bigint, jsonb, text)
  from public, anon, authenticated, service_role;
grant  execute on function public.save_sensor_design(uuid, text, text, numeric, double precision, double precision, bigint, jsonb, text)
  to authenticated, service_role;

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

-- ── ตรวจผล (แสดงทุกแถว) ──────────────────────────────────────────────────────
select 'table' as item, (select count(*)::text from public.sensor_designs) as value, (select relrowsecurity::text from pg_class where oid = 'public.sensor_designs'::regclass) as rls
union all
select 'policies', string_agg(policyname, ', '), null from pg_policies where tablename = 'sensor_designs'
union all
select 'anon select', has_table_privilege('anon', 'public.sensor_designs', 'select')::text, 'ต้อง false'
union all
select 'authenticated insert', has_table_privilege('authenticated', 'public.sensor_designs', 'insert')::text, 'ต้อง true'
union all
select 'rpc anon exec', has_function_privilege('anon', 'public.save_sensor_design(uuid,text,text,numeric,double precision,double precision,bigint,jsonb,text)', 'execute')::text, 'ต้อง false'
union all
select 'rpc authenticated exec', has_function_privilege('authenticated', 'public.save_sensor_design(uuid,text,text,numeric,double precision,double precision,bigint,jsonb,text)', 'execute')::text, 'ต้อง true';
