-- ═══════════════════════════════════════════════════════════════════════════
-- envi_pi — เปิดสิทธิ์ให้ Data API เข้าถึงตาราง (รันหลังไฟล์ 1-3)
--
-- ทำไมต้องมีไฟล์นี้
--   โปรเจกต์ Supabase ที่สร้างหลัง 30 พ.ค. 2569 ไม่ให้สิทธิ์ตารางใหม่โดยอัตโนมัติ
--   → ตารางที่ไม่ได้ grant จะตอบ 42501 permission denied ทั้งที่ RLS ถูกต้องแล้ว
--
-- หลักที่ยึด (ต่างจาก CRM ตรงที่ **anon อ่านข้อมูลราชการได้**)
--   anon           select ตารางข้อมูลราชการ + api_cache · ห้ามแตะ profiles/site_assessments/ingest_runs
--   authenticated  select ทุกตาราง + insert/update/delete (RLS เป็นคนตัดสินว่าแถวไหน)
--   service_role   ได้ทุกอย่าง (Edge Function ใช้)
--
-- บทเรียนจาก pi_crm_erp (20 ส.ค. 2569): ไม่ครอบทั้งไฟล์ด้วย begin/commit ดัก error รายตาราง
-- และ raise exception ตอนท้ายถ้ายังไม่ครบ — ไม่ปล่อยให้ "รันแล้วแต่ไม่มีอะไรเปลี่ยน"
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

grant usage on schema public to anon, authenticated, service_role;

-- ── 1. profiles ก่อนใคร ─────────────────────────────────────────────────────
grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;
revoke all on public.profiles from anon;

-- ── 2. ตารางข้อมูลราชการ — สาธารณะอ่านได้ ─────────────────────────────────
do $$
declare
  t text; ok_n int := 0; bad text[] := '{}';
begin
  foreach t in array array['sources','stations','observations','observations_daily',
                           'latest_observations','events','layers','layer_features','api_cache'] loop
    begin
      execute format('grant select on public.%I to anon', t);
      execute format('grant select, insert, update, delete on public.%I to authenticated', t);
      execute format('grant all on public.%I to service_role', t);
      ok_n := ok_n + 1;
    exception when others then
      bad := bad || (t || ' → ' || sqlerrm);
    end;
  end loop;

  -- ส่วนตัว: anon ห้าม
  foreach t in array array['site_assessments','ingest_runs'] loop
    begin
      execute format('revoke all on public.%I from anon', t);
      execute format('grant select, insert, update, delete on public.%I to authenticated', t);
      execute format('grant all on public.%I to service_role', t);
      ok_n := ok_n + 1;
    exception when others then
      bad := bad || (t || ' → ' || sqlerrm);
    end;
  end loop;

  raise notice 'ให้สิทธิ์สำเร็จ % ตาราง', ok_n;
  if array_length(bad, 1) is not null then
    raise warning 'ให้สิทธิ์ไม่ได้ % รายการ: %', array_length(bad, 1), array_to_string(bad, ' | ');
  end if;
end $$;

-- ── 3. วิว ──────────────────────────────────────────────────────────────────
do $$ begin
  grant select on public.v_station_latest, public.v_recent_events to anon, authenticated, service_role;
exception when others then raise warning 'views: %', sqlerrm; end $$;

-- ── 4. sequence ────────────────────────────────────────────────────────────
do $$ begin
  grant usage, select on all sequences in schema public to authenticated, service_role;
exception when others then raise warning 'sequences: %', sqlerrm; end $$;

-- ── 5. ตารางที่จะสร้างเพิ่มในอนาคต ─────────────────────────────────────────
do $$ begin
  alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
  alter default privileges in schema public grant all on tables to service_role;
  alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
exception when others then raise warning 'default privileges: %', sqlerrm; end $$;

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

-- ── 6. ตรวจผล — raise exception ถ้ายังไม่เรียบร้อย ──────────────────────────
do $$
declare miss text[] := '{}'; t text;
begin
  foreach t in array array['sources','stations','observations','observations_daily',
                           'latest_observations','events','layers','layer_features','api_cache'] loop
    if not has_table_privilege('anon', 'public.' || t, 'select') then miss := miss || (t || ' (anon)'); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then miss := miss || (t || ' (authenticated)'); end if;
  end loop;
  if array_length(miss, 1) is not null then
    raise exception 'ยังอ่านไม่ได้: %', array_to_string(miss, ', ');
  end if;
  if has_table_privilege('anon', 'public.profiles', 'select') then
    raise exception 'anon ยังอ่าน profiles ได้ — ต้องปิด';
  end if;
  if has_table_privilege('anon', 'public.site_assessments', 'select') then
    raise exception 'anon ยังอ่าน site_assessments ได้ — ต้องปิด';
  end if;
  raise notice '───────────────────────────────';
  raise notice ' เรียบร้อย — anon อ่านข้อมูลราชการได้ · authenticated ครบ · ส่วนตัวปิดจาก anon';
  raise notice '───────────────────────────────';
end $$;

select c.relname                                              as "ตาราง",
       has_table_privilege('anon',          c.oid, 'select')  as "anon",
       has_table_privilege('authenticated', c.oid, 'select')  as "authenticated",
       c.relrowsecurity                                       as "RLS"
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'public' and c.relkind = 'r'
 order by 1;
