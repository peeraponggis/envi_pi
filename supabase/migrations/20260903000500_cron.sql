-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — ตั้งเวลาดึงข้อมูล pg_cron → Edge Function (ไฟล์ที่ 5/5)          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- กลไก
--   pg_cron (รันเป็น postgres) → public.trigger_ingest('air4thai')
--     → อ่าน URL ของ Edge Function + token จาก Vault
--     → net.http_post ไปที่ Edge Function `envi-ingest` พร้อม {"source":"air4thai"}
--   Edge Function ตรวจ token → ดึงข้อมูลจากหน่วยงาน → upsert → บันทึก ingest_runs
--
-- ⚠️ ก่อนรันไฟล์นี้ ต้องสร้าง secret ใน Vault ก่อน (รันใน SQL Editor **ครั้งเดียว** ห้ามเขียนค่าลงไฟล์):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/envi-ingest', 'envi_ingest_url');
--   select vault.create_secret('<สุ่มยาว ๆ อย่างน้อย 32 ตัว>', 'envi_cron_token');
--   แล้วใส่ token ตัวเดียวกันใน Dashboard → Edge Functions → Secrets ชื่อ ENVI_CRON_TOKEN
--
-- ⚠️ ทุก job ตรวจ sources.cron_enabled ก่อนยิง — ตอนติดตั้งเป็น false ทั้งหมด
--   เปิดทีละแหล่งหลังกด Invoke ทดสอบผ่าน: update public.sources set cron_enabled = true where id = 'air4thai';
--
-- รันซ้ำได้ — unschedule ชื่อเดิมก่อนตั้งใหม่
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ฟังก์ชันยิง Edge Function ───────────────────────────────────────────
create or replace function public.trigger_ingest(p_source text)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text; v_token text; v_enabled boolean; v_req bigint;
begin
  select cron_enabled into v_enabled from public.sources where id = p_source;
  if v_enabled is distinct from true then
    return null;                                   -- ปิดอยู่ ไม่ยิง ไม่ log
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'envi_ingest_url'  limit 1;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'envi_cron_token' limit 1;
  if v_url is null or v_token is null then
    insert into public.ingest_runs (source_id, finished_at, ok, error)
    values (p_source, now(), false, 'ยังไม่ได้ตั้ง Vault secret envi_ingest_url / envi_cron_token');
    return null;
  end if;

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_token),
    body    := jsonb_build_object('source', p_source),
    timeout_milliseconds := 120000
  ) into v_req;
  return v_req;
end $$;

revoke execute on function public.trigger_ingest(text) from public;
grant  execute on function public.trigger_ingest(text) to service_role;

-- ── 2. ตารางเวลา (UTC — ไทย = UTC+7) ────────────────────────────────────────
do $$
declare
  j record;
  jobs constant jsonb := '[
    {"name":"envi_air4thai",            "cron":"7 * * * *",    "sql":"select public.trigger_ingest(''air4thai'')"},
    {"name":"envi_gistda_pm25",         "cron":"17 * * * *",   "sql":"select public.trigger_ingest(''gistda_pm25'')"},
    {"name":"envi_tmd_quake",           "cron":"*/15 * * * *", "sql":"select public.trigger_ingest(''tmd_quake'')"},
    {"name":"envi_hotspot_modis",       "cron":"25 */6 * * *", "sql":"select public.trigger_ingest(''gistda_hotspot_modis'')"},
    {"name":"envi_hotspot_viirs",       "cron":"35 */6 * * *", "sql":"select public.trigger_ingest(''gistda_hotspot_viirs'')"},
    {"name":"envi_royalrain",           "cron":"*/30 * * * *", "sql":"select public.trigger_ingest(''royalrain'')"},
    {"name":"envi_dgr_wells",           "cron":"45 20 * * 0",  "sql":"select public.trigger_ingest(''dgr_wells'')"},
    {"name":"envi_tmd_today",           "cron":"50 */3 * * *", "sql":"select public.trigger_ingest(''tmd_today'')"},
    {"name":"envi_tmd_3h",              "cron":"55 */3 * * *", "sql":"select public.trigger_ingest(''tmd_3h'')"},
    {"name":"envi_rollup_daily",        "cron":"30 18 * * *",  "sql":"select public.rollup_daily()"},
    {"name":"envi_purge_observations",  "cron":"0 19 * * 0",   "sql":"select public.purge_old_observations(180)"}
  ]'::jsonb;
begin
  for j in select * from jsonb_to_recordset(jobs) as x(name text, cron text, sql text) loop
    perform cron.unschedule(jobid) from cron.job where jobname = j.name;
    perform cron.schedule(j.name, j.cron, j.sql);
  end loop;
end $$;

-- ── ตรวจผล ──────────────────────────────────────────────────────────────────
select 'vault envi_ingest_url'  as "รายการ", (exists(select 1 from vault.secrets where name='envi_ingest_url'))::text  as "มี"
union all
select 'vault envi_cron_token', (exists(select 1 from vault.secrets where name='envi_cron_token'))::text
union all
select 'cron jobs envi_*', (select count(*)::text from cron.job where jobname like 'envi_%') || ' (ต้องได้ 11)';

select jobname as "job", schedule as "เวลา (UTC)", active as "เปิด" from cron.job where jobname like 'envi_%' order by 1;
