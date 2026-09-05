-- ═══════════════════════════════════════════════════════════════════════════
-- 20260903001300_purge_keep_lab.sql — purge_old_observations ยกเว้นผลตรวจแล็บที่ไม่ใช่รายชั่วโมง
--
-- ปัญหา: migration 1200 ตั้ง purge เก็บ 7 วัน แต่ observations ของ pcd_dspot เป็นผลตรวจปีละครั้ง
--        ลงวันที่ตรวจจริง (ธ.ค. 2567 – ธ.ค. 2568) จะถูกลบทิ้งในรอบแรก และ rollup_daily ก็ไม่ครอบคลุม
-- แก้:   ลบเฉพาะแถวของแหล่งที่ refresh_minutes <= 1440 (ดึงอย่างน้อยวันละครั้ง = ข้อมูลรายชั่วโมง/รายวัน)
--        แหล่งที่ดึงห่างกว่านั้น (pcd_dspot สัปดาห์ละครั้ง, ข้อมูลนำเข้ามือ) เก็บตลอด
-- รันซ้ำได้ · ไม่เปลี่ยน signature (cron เดิม select public.purge_old_observations(7) ใช้ต่อได้)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.purge_old_observations(p_keep_days int default 180)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  delete from public.observations o
   using public.stations s
   join public.sources src on src.id = s.source_id
   where o.station_id = s.id
     and coalesce(src.refresh_minutes, 0) between 1 and 1440       -- เฉพาะแหล่งอัตโนมัติรายชั่วโมง/รายวัน
     and o.observed_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  delete from public.api_cache where fetched_at < now() - interval '90 days';
  return n;
end $$;

revoke execute on function public.purge_old_observations(int) from public, anon, authenticated, service_role;
grant  execute on function public.purge_old_observations(int) to service_role;

-- ── ตรวจผล: แหล่งไหนจะถูก purge / เก็บตลอด และมีแถวเก่ากว่า 7 วันเท่าไร ──
select src.id, src.refresh_minutes,
       case when coalesce(src.refresh_minutes, 0) between 1 and 1440 then 'purge หลัง 7 วัน' else 'เก็บตลอด' end as policy,
       count(o.*) as obs_rows,
       count(o.*) filter (where o.observed_at < now() - interval '7 days') as older_than_7d
  from public.sources src
  join public.stations s on s.source_id = src.id
  left join public.observations o on o.station_id = s.id
 group by src.id, src.refresh_minutes
having count(o.*) > 0
 order by 1;
