-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — Row Level Security ทุกตาราง (ไฟล์ที่ 2/5)                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- หลักที่ยึด
--   • ข้อมูลราชการ (sources/stations/observations/events/layers) = **สาธารณะอ่านได้**
--     ทั้ง anon และ authenticated — เพราะนี่คือเว็บ "นำเสนอ" และข้อมูลต้นทางเป็นข้อมูลเปิดอยู่แล้ว
--     ⚠️ ถ้าต้องการให้ล็อกอินก่อนดู: ลบเฉพาะบล็อก "── anon ──" ท้ายไฟล์ แล้วรันไฟล์นี้ซ้ำ
--   • เขียนข้อมูลราชการได้เฉพาะ service_role (Edge Function) และ admin/editor (หน้า import)
--   • api_cache: ทุกคนอ่านได้ แต่ **เขียนได้เฉพาะคนล็อกอิน** — ถ้าให้ anon เขียน
--     ใครก็ยัดค่าปลอมแทน NASA POWER ให้คนอื่นเห็นได้ (cache poisoning)
--   • site_assessments: เจ้าของอ่าน/เขียนของตัวเอง · admin อ่านทั้งหมด
--   • ingest_runs: admin อ่านอย่างเดียว (Edge เขียนผ่าน service_role)
--
-- ⚠️ RLS ไม่ใช่ grant — ไฟล์นี้ตัดสิน "เห็นแถวไหน" ส่วน "เข้าถึงตารางได้ไหม"
--    อยู่ที่ supabase/เปิดสิทธิ์ Data API.sql (โปรเจกต์ใหม่ไม่มี default privileges)
--
-- รันซ้ำได้ — ทุก policy ใช้ drop if exists ก่อน create
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. บทบาทของผู้ใช้ปัจจุบัน ────────────────────────────────────────────────
--   security definer เพื่อไม่ให้ policy ของ profiles เรียกตัวเองวน (infinite recursion)
create or replace function public.app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'viewer'::user_role);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.app_role() = 'admin';
$$;

create or replace function public.can_import() returns boolean
language sql stable security definer set search_path = public as $$
  select public.app_role() in ('admin', 'editor');
$$;

-- ── 1. เปิด RLS ทุกตาราง ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['profiles','sources','stations','observations','observations_daily',
                           'latest_observations','events','layers','layer_features',
                           'site_assessments','ingest_runs','api_cache'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ── 2. profiles ────────────────────────────────────────────────────────────
drop policy if exists p_profiles_self_read  on public.profiles;
drop policy if exists p_profiles_admin_read on public.profiles;
drop policy if exists p_profiles_self_write on public.profiles;
drop policy if exists p_profiles_admin_all  on public.profiles;

create policy p_profiles_self_read on public.profiles
  for select to authenticated using (id = auth.uid());
create policy p_profiles_admin_read on public.profiles
  for select to authenticated using (public.is_admin());
-- แก้ชื่อตัวเองได้ แต่ **เลื่อน role ตัวเองไม่ได้** (with check บังคับให้ role คงเดิม)
create policy p_profiles_self_write on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.app_role());
create policy p_profiles_admin_all on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── 3. ตารางข้อมูลราชการ — authenticated อ่านได้ ────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['sources','stations','observations','observations_daily',
                           'latest_observations','events','layers','layer_features','api_cache'] loop
    execute format('drop policy if exists p_%s_auth_read on public.%I', t, t);
    execute format('create policy p_%s_auth_read on public.%I for select to authenticated using (true)', t, t);
  end loop;
end $$;

-- ── 4. นำเข้าด้วยมือ — admin/editor เขียน stations/events/layers/layer_features ได้
do $$
declare t text;
begin
  foreach t in array array['stations','events','layers','layer_features'] loop
    execute format('drop policy if exists p_%s_import_write on public.%I', t, t);
    execute format(
      'create policy p_%s_import_write on public.%I for all to authenticated using (public.can_import()) with check (public.can_import())',
      t, t);
  end loop;
end $$;

-- sources: admin แก้ได้ (เปิด/ปิด cron, แก้ notes)
drop policy if exists p_sources_admin_write on public.sources;
create policy p_sources_admin_write on public.sources
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── 5. api_cache — คนล็อกอินเขียนแคชได้ ────────────────────────────────────
drop policy if exists p_api_cache_auth_write on public.api_cache;
create policy p_api_cache_auth_write on public.api_cache
  for all to authenticated using (true) with check (true);

-- ── 6. site_assessments ────────────────────────────────────────────────────
drop policy if exists p_assess_owner on public.site_assessments;
drop policy if exists p_assess_admin_read on public.site_assessments;
create policy p_assess_owner on public.site_assessments
  for all to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());
create policy p_assess_admin_read on public.site_assessments
  for select to authenticated using (public.is_admin());

-- ── 7. ingest_runs — admin อ่าน ────────────────────────────────────────────
drop policy if exists p_ingest_admin_read on public.ingest_runs;
create policy p_ingest_admin_read on public.ingest_runs
  for select to authenticated using (public.is_admin());

-- ── anon ── เว็บสาธารณะ: คนไม่ล็อกอินอ่านข้อมูลราชการได้ ─────────────────────
--   ลบบล็อกนี้ (แล้วรัน drop policy ด้านล่างค้างไว้) ถ้าต้องการให้ล็อกอินก่อนดู
do $$
declare t text;
begin
  foreach t in array array['sources','stations','observations','observations_daily',
                           'latest_observations','events','layers','layer_features','api_cache'] loop
    execute format('drop policy if exists p_%s_anon_read on public.%I', t, t);
    execute format('create policy p_%s_anon_read on public.%I for select to anon using (true)', t, t);
  end loop;
end $$;
-- ── จบบล็อก anon ──

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

-- ── ตรวจผล — ทุกตารางต้องเปิด RLS และมี policy อย่างน้อย 1 ────────────────
do $$
declare bad text[] := '{}'; r record;
begin
  for r in
    select c.relname, c.relrowsecurity,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as n_pol
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname in ('profiles','sources','stations','observations','observations_daily',
                         'latest_observations','events','layers','layer_features',
                         'site_assessments','ingest_runs','api_cache')
  loop
    if not r.relrowsecurity or r.n_pol = 0 then
      bad := bad || (r.relname || format(' (rls=%s, policies=%s)', r.relrowsecurity, r.n_pol));
    end if;
  end loop;
  if array_length(bad, 1) is not null then
    raise exception 'RLS ยังไม่ครบ: %', array_to_string(bad, ', ');
  end if;
  raise notice 'RLS เรียบร้อยครบ 12 ตาราง';
end $$;

select c.relname as "ตาราง", c.relrowsecurity as "RLS",
       (select string_agg(p.polname, ', ' order by p.polname) from pg_policy p where p.polrelid = c.oid) as "policies"
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by 1;
