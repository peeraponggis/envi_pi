-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  envi_pi — โครงฐานข้อมูลข้อมูลสิ่งแวดล้อมประเทศไทย (ไฟล์ที่ 1/5)          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- โปรเจกต์ Supabase **แยกต่างหาก** จาก pi-boq-dev (ตัดสินใจ 3 ก.ย. 2569)
-- จึงใช้ schema public ได้เลย ไม่ต้องไปเพิ่ม Exposed schemas
--
-- แนวคิด
--   sources      ทะเบียนแหล่งข้อมูลราชการ (ใครให้ / ให้แบบไหน / สัญญาอนุญาต)
--   stations     จุดตรวจวัดทุกชนิด (สถานีอากาศ, บ่อบาดาล, สถานีอุตุ …) มี geom
--   observations ค่าตรวจวัดแบบ long (station, เวลา, พารามิเตอร์, ค่า) — เก็บรายชั่วโมง 180 วัน
--   latest_observations แถวล่าสุดต่อสถานี/พารามิเตอร์ ให้แผนที่โหลดเร็ว
--   observations_daily  สรุปรายวัน min/avg/max เก็บยาว
--   events       เหตุการณ์จุด: จุดความร้อน แผ่นดินไหว ดินถล่ม น้ำท่วม
--   layers/layer_features  ชั้นโพลิกอนนิ่ง: ป่าสงวน ลุ่มน้ำ อุทยาน การใช้ที่ดิน
--   site_assessments  ผลวิเคราะห์จุดที่ผู้ใช้บันทึก
--   ingest_runs  บันทึกทุกรอบที่ Edge Function ดึงข้อมูล (สำเร็จ/ล้ม/กี่แถว)
--   api_cache    แคชผล NASA POWER / PVGIS / Nominatim ที่เบราว์เซอร์เรียกสด
--
-- ใช้ PostGIS เพราะ site report ต้องตอบ 3 อย่างที่ SQL ธรรมดาตอบไม่คุ้ม:
--   สถานีใกล้สุด (KNN) · เหตุการณ์ในรัศมี (ST_DWithin) · จุดตกในโพลิกอน (ST_Contains)
-- ⚠️ Supabase ติดตั้ง PostGIS ไว้ใน schema `extensions` — ต้องเขียน extensions.ST_xxx
--    ใน generated column ทุกจุด ไม่งั้น SQL Editor ล้มด้วย "function st_makepoint does not exist"
--
-- รันซ้ำได้ (idempotent) — ทดสอบบนโปรเจกต์ Supabase จริงเท่านั้น (PGlite ไม่มี PostGIS)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. extensions ──────────────────────────────────────────────────────────
create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron;                      -- ตั้งเวลา (ไฟล์ที่ 5)
create extension if not exists pg_net with schema extensions; -- ยิง HTTP จาก cron ไป Edge Function

-- ── 2. enum ────────────────────────────────────────────────────────────────
do $$ begin
  create type user_role as enum ('admin', 'editor', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  -- วิธีเข้าถึงแหล่งข้อมูล — ใช้ตัดสินว่าดึงอัตโนมัติได้ไหม หรือต้องนำเข้าด้วยมือ
  create type access_mode as enum (
    'open_json',     -- API เปิด ไม่ต้องสมัคร (Air4Thai, GISTDA PM2.5, DGR)
    'key_json',      -- API ต้องสมัคร key ฟรี (TMD, GISTDA gateway, FIRMS)
    'arcgis_rest',   -- ArcGIS MapServer query (GISTDA hotspot)
    'rss',           -- RSS/XML (แผ่นดินไหว TMD)
    'wms',           -- tile/WMS ซ้อนบนแผนที่ ไม่เก็บลง DB
    'static_file',   -- SHP/CSV ดาวน์โหลดครั้งเดียว นำเข้าผ่านหน้า import
    'browser_only',  -- มีแต่หน้าเว็บ ไม่มี API
    'manual'         -- คัดลอกมือลง CSV
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type event_kind as enum ('hotspot', 'earthquake', 'landslide', 'flood', 'warning', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type obs_quality as enum ('ok', 'missing', 'suspect');
exception when duplicate_object then null; end $$;

-- ── 3. ฟังก์ชันช่วย updated_at ─────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── 4. profiles — ผู้ใช้ของโปรเจกต์นี้ (แยกจาก CRM) ─────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        user_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'ผู้ใช้ envi_pi — role: admin ตั้งค่า/นำเข้า · editor นำเข้าไฟล์ · viewer ดู+บันทึกผลวิเคราะห์ของตัวเอง';

-- สร้าง profile อัตโนมัติเมื่อมีผู้ใช้ใหม่ใน Authentication
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── 5. sources — ทะเบียนแหล่งข้อมูล ────────────────────────────────────────
create table if not exists public.sources (
  id               text primary key,              -- 'air4thai', 'gistda_hotspot_modis', …
  category         text not null,                 -- 'air','disaster','water','forest','land','eia','waste','weather','solar','admin'
  agency           text not null,                 -- ชื่อหน่วยงานภาษาไทย
  name_th          text not null,
  url              text,
  access_mode      access_mode not null,
  license          text,                          -- 'Open Data Common', 'CC BY', 'CC BY-NC-ND' …
  refresh_minutes  int,                           -- null = ไม่ดึงอัตโนมัติ
  cron_enabled     boolean not null default false,
  handler          text,                          -- ชื่อ handler ใน Edge Function (null = ไม่มี)
  verified_at      date,                          -- วันที่ยิง endpoint แล้วได้ผลจริง
  notes            text,
  meta             jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);
comment on table public.sources is 'ทะเบียนแหล่งข้อมูลราชการ — license ต้องแสดงเครดิตบนแผนที่เสมอ';

drop trigger if exists trg_sources_touch on public.sources;
create trigger trg_sources_touch before update on public.sources
  for each row execute function public.touch_updated_at();

-- ── 6. stations — จุดตรวจวัด ───────────────────────────────────────────────
create table if not exists public.stations (
  id            bigint generated always as identity primary key,
  source_id     text not null references public.sources(id) on delete cascade,
  ext_id        text not null,                    -- รหัสของหน่วยงาน เช่น '44t'
  name_th       text,
  name_en       text,
  area_th       text,                             -- ตำบล/อำเภอ/จังหวัด ตามที่แหล่งให้มา
  province      text,
  station_type  text,                             -- GROUND / BKK / MOBILE / well / synop …
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  geom          extensions.geography(Point, 4326)
                generated always as (
                  extensions.ST_SetSRID(extensions.ST_MakePoint(lng, lat), 4326)::extensions.geography
                ) stored,
  active        boolean not null default true,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_id, ext_id)
);
create index if not exists idx_stations_geom   on public.stations using gist (geom);
create index if not exists idx_stations_source on public.stations (source_id) where active;

drop trigger if exists trg_stations_touch on public.stations;
create trigger trg_stations_touch before update on public.stations
  for each row execute function public.touch_updated_at();

-- ── 7. observations — ค่าตรวจวัดรายชั่วโมง (long) ──────────────────────────
--   ปริมาณ: Air4Thai 200 สถานี × 7 พารามิเตอร์ × 24 ชม. ≈ 34,000 แถว/วัน ≈ 12 ล้านแถว/ปี
--   → เก็บ 180 วัน แล้วให้ cron ลบ (ไฟล์ที่ 5) ส่วนรายวันสรุปไว้ใน observations_daily
create table if not exists public.observations (
  station_id   bigint not null references public.stations(id) on delete cascade,
  observed_at  timestamptz not null,
  parameter    text not null,                     -- 'PM25','PM10','O3','CO','NO2','SO2','AQI','tc','rh','rain' …
  value        double precision,                  -- null เมื่อไม่มีค่า (ห้ามเก็บ -999)
  unit         text,
  quality      obs_quality not null default 'ok',
  primary key (station_id, parameter, observed_at)
);
create index if not exists idx_obs_time on public.observations using brin (observed_at);

create table if not exists public.observations_daily (
  station_id   bigint not null references public.stations(id) on delete cascade,
  day          date not null,                     -- วันตามเวลาไทย
  parameter    text not null,
  value_min    double precision,
  value_avg    double precision,
  value_max    double precision,
  n            int not null default 0,            -- จำนวนชั่วโมงที่มีค่า
  unit         text,
  primary key (station_id, parameter, day)
);
create index if not exists idx_obs_daily_day on public.observations_daily (day);

create table if not exists public.latest_observations (
  station_id   bigint not null references public.stations(id) on delete cascade,
  parameter    text not null,
  observed_at  timestamptz not null,
  value        double precision,
  unit         text,
  extra        jsonb not null default '{}'::jsonb, -- เช่น {"color_id":"3","aqi_param":"PM25"}
  primary key (station_id, parameter)
);

-- ── 8. events — เหตุการณ์จุด ───────────────────────────────────────────────
create table if not exists public.events (
  id            bigint generated always as identity primary key,
  source_id     text not null references public.sources(id) on delete cascade,
  kind          event_kind not null,
  ext_id        text not null,                    -- กันซ้ำ: hotspot = lat|lng|acq_time · quake = guid
  occurred_at   timestamptz not null,
  lat           double precision not null,
  lng           double precision not null,
  geom          extensions.geography(Point, 4326)
                generated always as (
                  extensions.ST_SetSRID(extensions.ST_MakePoint(lng, lat), 4326)::extensions.geography
                ) stored,
  magnitude     double precision,                 -- FRP / แมกนิจูด / ความรุนแรง
  title         text,
  province      text,
  props         jsonb not null default '{}'::jsonb,
  imported_manually boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (source_id, ext_id)
);
create index if not exists idx_events_geom      on public.events using gist (geom);
create index if not exists idx_events_kind_time on public.events (kind, occurred_at desc);

-- ── 9. layers / layer_features — ชั้นโพลิกอนนิ่ง ───────────────────────────
create table if not exists public.layers (
  id             text primary key,                -- 'rfd_reserve_forest', 'dwr_basin', 'ldd_landuse_xxx'
  source_id      text references public.sources(id) on delete set null,
  name_th        text not null,
  geom_type      text not null default 'MultiPolygon',
  feature_count  int not null default 0,
  loaded_at      timestamptz,
  loaded_by      uuid references public.profiles(id) on delete set null,
  style          jsonb not null default '{}'::jsonb, -- {"fill":"#2e7d32","opacity":0.35}
  notes          text,
  updated_at     timestamptz not null default now()
);

drop trigger if exists trg_layers_touch on public.layers;
create trigger trg_layers_touch before update on public.layers
  for each row execute function public.touch_updated_at();

create table if not exists public.layer_features (
  id        bigint generated always as identity primary key,
  layer_id  text not null references public.layers(id) on delete cascade,
  ext_id    text,
  name_th   text,
  props     jsonb not null default '{}'::jsonb,
  geom      extensions.geometry(Geometry, 4326) not null
);
create index if not exists idx_lf_geom  on public.layer_features using gist (geom);
create index if not exists idx_lf_layer on public.layer_features (layer_id);

-- ── 10. site_assessments — ผลวิเคราะห์จุดที่ผู้ใช้บันทึก ────────────────────
create table if not exists public.site_assessments (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  geom        extensions.geography(Point, 4326)
              generated always as (
                extensions.ST_SetSRID(extensions.ST_MakePoint(lng, lat), 4326)::extensions.geography
              ) stored,
  report      jsonb not null,                     -- ก้อนที่ site_report() คืน ณ เวลาบันทึก (snapshot)
  ref_note    text,                               -- อ้างอิงงาน/ลูกค้าเป็นข้อความ ไม่ผูก FK ข้ามโปรเจกต์
  created_at  timestamptz not null default now()
);
create index if not exists idx_assess_owner on public.site_assessments (created_by, created_at desc);

-- ── 11. ingest_runs — บันทึกทุกรอบที่ดึงข้อมูล ─────────────────────────────
create table if not exists public.ingest_runs (
  id             bigint generated always as identity primary key,
  source_id      text not null,
  fn_version     text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rows_upserted  int not null default 0,
  ok             boolean,
  error          text,
  cursor         jsonb                            -- สำหรับแหล่งที่ต้องดึงหลายรอบ (DGR หน้าที่เท่าไหร่)
);
create index if not exists idx_ingest_runs_src on public.ingest_runs (source_id, started_at desc);

-- ── 12. api_cache — แคชผลที่เบราว์เซอร์เรียกสด ─────────────────────────────
create table if not exists public.api_cache (
  cache_key   text primary key,                   -- 'nasa_power:13.75,100.56'
  source_id   text,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);
create index if not exists idx_api_cache_time on public.api_cache (fetched_at);

do $$ begin perform pg_notify('pgrst', 'reload schema'); exception when others then null; end $$;

-- ── ตรวจผล — แสดงทุกแถวเสมอ ให้คนอ่านตัดสิน ───────────────────────────────
select t.name as "ตาราง",
       (to_regclass('public.' || t.name) is not null) as "มี",
       coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t.name)), false) as "RLS (เปิดในไฟล์ที่ 2)"
  from unnest(array['profiles','sources','stations','observations','observations_daily',
                    'latest_observations','events','layers','layer_features',
                    'site_assessments','ingest_runs','api_cache']) as t(name)
union all
select 'extension postgis', exists(select 1 from pg_extension where extname='postgis'), null
union all
select 'extension pg_cron', exists(select 1 from pg_extension where extname='pg_cron'), null
union all
select 'extension pg_net', exists(select 1 from pg_extension where extname='pg_net'), null;
