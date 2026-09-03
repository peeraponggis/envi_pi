-- ═══════════════════════════════════════════════════════════════════════════
-- envi_pi — ตรวจสภาพระบบหลังติดตั้ง / ตอนสงสัยว่าอะไรพัง
--
-- แสดง **ทุกแถว** เสมอ ให้คนอ่านตัดสินเอง (บทเรียน: กรองด้วยค่าที่อาจไม่มีจริง
-- แล้วแถวหายทั้งแถว อ่านแล้วนึกว่าผ่าน)
-- raise exception เฉพาะเรื่องที่ระบบใช้งานไม่ได้แน่ ๆ (ตารางหาย / RLS ปิด / grant ขาด)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ตาราง · RLS · สิทธิ์ · จำนวนแถว ──────────────────────────────────────
create or replace function pg_temp.row_count(p_table text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I', p_table) into n;
  return n;
exception when others then return -1;
end $$;

select t.name                                                   as "ตาราง",
       (to_regclass('public.' || t.name) is not null)           as "มี",
       coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.' || t.name)), false) as "RLS",
       (select count(*) from pg_policy where polrelid = to_regclass('public.' || t.name)) as "policies",
       case when to_regclass('public.' || t.name) is null then null
            else has_table_privilege('anon', 'public.' || t.name, 'select') end as "anon อ่าน",
       case when to_regclass('public.' || t.name) is null then null
            else has_table_privilege('authenticated', 'public.' || t.name, 'select') end as "auth อ่าน",
       case when to_regclass('public.' || t.name) is null then null
            else pg_temp.row_count(t.name) end                    as "แถว"
  from unnest(array['profiles','sources','stations','observations','observations_daily',
                    'latest_observations','events','layers','layer_features',
                    'site_assessments','ingest_runs','api_cache']) as t(name)
 order by 1;

-- ── 2. extensions / ฟังก์ชัน / วิว ───────────────────────────────────────────
select 'extension ' || e.name as "รายการ", exists(select 1 from pg_extension where extname = e.name) as "มี"
  from unnest(array['postgis','pg_cron','pg_net','supabase_vault']) e(name)
union all
select 'function ' || f.name, exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'public' and p.proname = f.name)
  from unnest(array['site_report','nearest_stations','layer_features_bbox','save_assessment',
                    'rollup_daily','purge_old_observations','trigger_ingest','app_role',
                    'import_features','import_events','import_stations']) f(name)
union all
select 'view ' || v.name, to_regclass('public.' || v.name) is not null
  from unnest(array['v_station_latest','v_recent_events']) v(name)
union all
select 'vault envi_ingest_url', exists(select 1 from vault.secrets where name = 'envi_ingest_url')
union all
select 'vault envi_cron_token', exists(select 1 from vault.secrets where name = 'envi_cron_token');

-- ── 3. cron ────────────────────────────────────────────────────────────────
select j.jobname as "job", j.schedule as "UTC", j.active as "active",
       (select max(start_time) from cron.job_run_details d where d.jobid = j.jobid) as "รันล่าสุด",
       (select status from cron.job_run_details d where d.jobid = j.jobid order by start_time desc limit 1) as "สถานะล่าสุด"
  from cron.job j where j.jobname like 'envi_%' order by 1;

-- ── 4. แหล่งข้อมูล — รอบดึงล่าสุดของแต่ละแหล่ง ───────────────────────────────
select s.id as "แหล่ง", s.cron_enabled as "cron", s.handler,
       r.started_at as "รอบล่าสุด", r.ok, r.rows_upserted as "แถว", left(r.error, 120) as "error",
       (select count(*) from public.stations st where st.source_id = s.id) as "สถานี",
       (select count(*) from public.events e where e.source_id = s.id) as "เหตุการณ์"
  from public.sources s
  left join lateral (select * from public.ingest_runs r where r.source_id = s.id order by started_at desc limit 1) r on true
 where s.handler is not null
 order by s.category, s.id;

-- ── 5. ผู้ใช้ ────────────────────────────────────────────────────────────────
select p.email, p.role, p.created_at from public.profiles p order by created_at;

-- ── 6. ล้มถ้าใช้งานไม่ได้แน่ ๆ ─────────────────────────────────────────────
do $$
declare bad text[] := '{}'; t text;
begin
  foreach t in array array['sources','stations','observations','latest_observations','events',
                           'layers','layer_features','site_assessments','ingest_runs','api_cache','profiles'] loop
    if to_regclass('public.' || t) is null then bad := bad || (t || ' ไม่มี'); continue; end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || t)) then bad := bad || (t || ' RLS ปิด'); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then bad := bad || (t || ' authenticated อ่านไม่ได้'); end if;
  end loop;
  if to_regprocedure('public.site_report(double precision,double precision)') is null then bad := bad || 'site_report ไม่มี'; end if;
  if not exists(select 1 from pg_extension where extname = 'postgis') then bad := bad || 'postgis ไม่มี'; end if;
  if array_length(bad, 1) is not null then
    raise exception 'ระบบยังใช้งานไม่ได้: %', array_to_string(bad, ' | ');
  end if;
  raise notice 'โครงสร้างครบ — ดูตาราง 4 ว่าแหล่งไหนดึงข้อมูลได้แล้ว';
end $$;
