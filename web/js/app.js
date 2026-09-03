/**
 * app.js — ที่เดียวที่แตะ DOM และ Cesium
 *
 * โครงจากไฟล์ V2.9.0: sidebar ซ้าย + globe ขวา · แท็บหมวด · ปุ่มประมวลผล · panel ผลลัพธ์
 * ต่างจากเดิม: ข้อมูลทุกหมวดมาจาก Supabase (site_report) และ API จริง — ไม่มี Math.random / ค่าคงที่
 */
import * as core from './envi-core.js';
import { CATEGORIES, TILE_LAYERS, DEFAULT_LAT, DEFAULT_LNG, AQI_LEVELS } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  viewer: null, layers: {}, category: 'air',
  entities: { stations: [], events: [], marker: [] },
  lat: DEFAULT_LAT, lng: DEFAULT_LNG,
  profile: null, report: null, address: null, sources: [],
};

// ════════════════════════════════════════════════════════════ แผนที่

async function initMap() {
  Cesium.Ion.defaultAccessToken = '';
  state.viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, infoBox: true,
    sceneModePicker: false, selectionIndicator: true, navigationHelpButton: false,
    animation: false, timeline: false, fullscreenButton: false,
  });
  const v = state.viewer;
  // ⚠️ UrlTemplateImageryProvider ใน Cesium 1.115 ใช้ constructor ตรง ๆ — ไม่มี .fromUrl()
  //    (ไฟล์ V2.9.0 เดิมเรียก fromUrl แล้วล้มเงียบใน try/catch ทำให้แผนที่ดำ)
  const add = async (key, url, opts = {}, show = true, alpha = 1) => {
    try {
      const p = new Cesium.UrlTemplateImageryProvider({ url, tilingScheme: new Cesium.WebMercatorTilingScheme(), ...opts });
      const l = new Cesium.ImageryLayer(p); l.show = show; l.alpha = alpha;
      v.imageryLayers.add(l); state.layers[key] = l;
    } catch (e) { console.warn('โหลดชั้น', key, 'ไม่ได้', e); }
  };
  await add('esri', TILE_LAYERS.esri, { credit: 'Tiles © Esri' });
  await add('gibs_ndvi', TILE_LAYERS.gibs_ndvi, { maximumLevel: 9, credit: 'NASA GIBS' }, false, 0.55);
  await add('gistda_aq', TILE_LAYERS.gistda_aq, { credit: 'GISTDA' }, false, 0.6);

  v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(100.9, 13.5, 1_600_000) });

  // คลิกแผนที่ = เลือกพิกัด (คลิกจุดสถานีให้ infoBox ทำงานตามปกติ)
  const h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
  h.setInputAction((ev) => {
    const picked = v.scene.pick(ev.position);
    if (Cesium.defined(picked) && picked.id) return;
    const cart = v.camera.pickEllipsoid(ev.position, v.scene.globe.ellipsoid);
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    setCoords(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function clearEntities(group) {
  state.entities[group].forEach((e) => state.viewer.entities.remove(e));
  state.entities[group] = [];
}

function setCoords(lat, lng) {
  state.lat = lat; state.lng = lng;
  $('coords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  drawMarker();
}

function drawMarker() {
  clearEntities('marker');
  const v = state.viewer, off = 0.00035;
  state.entities.marker.push(v.entities.add({
    rectangle: { coordinates: Cesium.Rectangle.fromDegrees(state.lng - off, state.lat - off, state.lng + off, state.lat + off),
      material: Cesium.Color.fromCssColorString('#00e676').withAlpha(0.12), outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#ffd54f'), outlineWidth: 3 },
  }));
  state.entities.marker.push(v.entities.add({
    position: Cesium.Cartesian3.fromDegrees(state.lng, state.lat),
    point: { pixelSize: 10, color: Cesium.Color.fromCssColorString('#ff5252'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
  }));
}

function flyTo(lat, lng, height = 190) {
  state.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lng, lat - 0.0014 * (height / 190), height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
  });
}

// ── สถานีอากาศเป็นจุดสี ─────────────────────────────────────────────────────
async function drawAirStations() {
  clearEntities('stations');
  let rows = [];
  try { rows = await core.fetchStationsLatest('air4thai'); }
  catch (e) { setStatus('โหลดสถานีไม่ได้: ' + e.message, 'crit'); return; }
  for (const s of rows) {
    const color = core.stationColor(s.latest);
    const aqi = s.latest?.AQI?.value, pm = s.latest?.PM25?.value;
    const desc = `
      <p><b>${esc(s.name_th)}</b><br><small>${esc(s.area_th ?? '')}</small></p>
      <p>AQI: <b>${aqi ?? '—'}</b> (${esc(core.aqiLevel(aqi).label)})<br>
         PM2.5: <b>${pm ?? '—'}</b> µg/m³ · PM10: ${s.latest?.PM10?.value ?? '—'} · O₃: ${s.latest?.O3?.value ?? '—'} ppb</p>
      <p><small>เวลา ${esc(core.fmtThaiDateTime(s.observed_at))} · ${esc(core.ago(s.observed_at))}<br>ที่มา: กรมควบคุมมลพิษ Air4Thai · รหัส ${esc(s.ext_id)}</small></p>`;
    state.entities.stations.push(state.viewer.entities.add({
      name: `สถานี ${s.name_th}`, description: desc,
      position: Cesium.Cartesian3.fromDegrees(s.lng, s.lat),
      point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(color), outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
  }
  $('airLegend').innerHTML = AQI_LEVELS.map((l) => `<span class="lg"><i style="background:${l.color}"></i>${esc(l.label)}</span>`).join('') +
    `<div class="hint">สถานี ${rows.length} แห่ง · ${rows[0]?.observed_at ? 'อัปเดต ' + esc(core.ago(rows.reduce((m, r) => (r.observed_at > m ? r.observed_at : m), ''))) : 'ยังไม่มีข้อมูล — ให้ Edge Function ดึง air4thai ก่อน'}</div>`;
}

// ── เหตุการณ์ (จุดความร้อน / แผ่นดินไหว / ดินถล่ม) ────────────────────────────
const EVENT_STYLE = {
  hotspot:    { color: '#ff6d00', size: 6,  label: 'จุดความร้อน 7 วัน' },
  earthquake: { color: '#e040fb', size: 10, label: 'แผ่นดินไหว 30 วัน' },
  landslide:  { color: '#8d6e63', size: 7,  label: 'ดินถล่ม (ประวัติ)' },
  flood:      { color: '#2979ff', size: 7,  label: 'น้ำท่วม 30 วัน' },
};
async function drawEvents() {
  clearEntities('events');
  // ดินถล่ม DMR มี 56,177 จุดทั้งประเทศ — ไม่วาดทั้งหมด (Cesium อืด) แสดงเฉพาะที่อยู่ใน 10 กม. ของจุดวิเคราะห์ผ่าน site_report
  const wanted = [['hotspot', 7], ['earthquake', 30], ['flood', 30]];
  const counts = { landslide: 'เฉพาะรอบจุดวิเคราะห์' };
  for (const [kind, days] of wanted) {
    let rows = [];
    try { rows = await core.fetchRecentEvents(kind, days, kind === 'hotspot' ? 5000 : 2000); } catch { rows = []; }
    counts[kind] = rows.length;
    const st = EVENT_STYLE[kind];
    for (const e of rows) {
      state.entities.events.push(state.viewer.entities.add({
        name: st.label, description: `<p><b>${esc(e.title ?? st.label)}</b></p><p>${esc(core.fmtThaiDateTime(e.occurred_at))}${e.magnitude != null ? ` · ${kind === 'earthquake' ? 'M ' : 'FRP '}${e.magnitude}` : ''}${e.province ? ' · ' + esc(e.province) : ''}</p><p><small>ที่มา: ${esc(e.source_id)}${e.imported_manually ? ' (นำเข้าด้วยมือ)' : ''}</small></p>`,
        position: Cesium.Cartesian3.fromDegrees(e.lng, e.lat),
        point: { pixelSize: kind === 'earthquake' ? Math.max(6, (e.magnitude ?? 3) * 3) : st.size, color: Cesium.Color.fromCssColorString(st.color).withAlpha(0.85),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.5), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    }
  }
  $('eventLegend').innerHTML = Object.entries(EVENT_STYLE).map(([k, s]) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.label)} (${counts[k] ?? 0})</span>`).join('');
}

/** จุดดินถล่มใน 10 กม. ของจุดวิเคราะห์ (จาก site_report) — วาดแทนการโหลดทั้ง 56k จุด */
function drawNearbyLandslides(rep) {
  state.entities.events = state.entities.events.filter((e) => { if (e.__nearby) { state.viewer.entities.remove(e); return false; } return true; });
  const st = EVENT_STYLE.landslide;
  for (const x of rep?.landslides_10km?.items ?? []) {
    const ent = state.viewer.entities.add({
      name: st.label, description: `<p><b>${esc(x.title ?? 'ดินถล่ม')}</b></p><p>ห่าง ${Math.round(x.distance_m)} ม.${x.props?.remark ? ' · ' + esc(x.props.remark) : ''}</p><p><small>ที่มา: กรมทรัพยากรธรณี (บัญชีดินถล่ม 2532-2562)</small></p>`,
      position: Cesium.Cartesian3.fromDegrees(x.lng, x.lat),
      point: { pixelSize: st.size, color: Cesium.Color.fromCssColorString(st.color).withAlpha(0.9), outlineColor: Cesium.Color.WHITE.withAlpha(0.6), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      show: state.category === 'disaster' || state.category === 'water',
    });
    ent.__nearby = true;
    state.entities.events.push(ent);
  }
}

// ════════════════════════════════════════════════════════════ แท็บหมวด

function renderTabs() {
  $('tabs').innerHTML = CATEGORIES.map((c) =>
    `<button class="tab-btn${c.key === state.category ? ' active' : ''}" data-cat="${c.key}" title="เฟส ${c.phase}">${esc(c.label)}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => switchCategory(b.dataset.cat)));
}

function switchCategory(key) {
  state.category = key;
  renderTabs();
  document.querySelectorAll('[data-panel]').forEach((el) => { el.hidden = el.dataset.panel !== key; });
  state.layers.gibs_ndvi && (state.layers.gibs_ndvi.show = key === 'vegetation');
  state.layers.gistda_aq && (state.layers.gistda_aq.show = key === 'air' && $('chkAqTile').checked);
  state.entities.stations.forEach((e) => (e.show = key === 'air'));
  state.entities.events.forEach((e) => (e.show = key === 'disaster' || key === 'water'));
  if (state.burnDs) state.burnDs.show = key === 'disaster';
  renderReport();
}

// ════════════════════════════════════════════════════════════ วิเคราะห์จุด

function setStatus(msg, level = '') {
  const el = $('status'); el.textContent = msg; el.className = 'status ' + level; el.hidden = !msg;
}

async function analyze() {
  const c = core.parseCoords($('coords').value);
  if (!c) { setStatus('รูปแบบพิกัดไม่ถูกต้อง — ใช้ "ละติจูด, ลองจิจูด"', 'crit'); return; }
  setCoords(c.lat, c.lng);
  flyTo(c.lat, c.lng);
  $('resultPanel').hidden = false;
  $('panelBody').innerHTML = '<div class="loading">🔄 กำลังรวบรวมข้อมูลจากหน่วยงานราชการรอบพิกัด…</div>';
  setStatus('');

  const [addr, rep] = await Promise.allSettled([core.reverseGeocode(c.lat, c.lng), core.siteReport(c.lat, c.lng)]);
  state.address = addr.status === 'fulfilled' ? addr.value : null;
  if (rep.status === 'rejected') {
    $('panelBody').innerHTML = `<div class="err">เรียก site_report ไม่ได้: ${esc(rep.reason?.message)}<br><small>ตรวจว่า config.js ตั้งค่าแล้ว และรัน SQL ไฟล์ 1-3 + เปิดสิทธิ์ Data API แล้ว</small></div>`;
    return;
  }
  state.report = rep.value;
  drawNearbyLandslides(rep.value);
  renderReport();

  // แสงอาทิตย์ + พยากรณ์อากาศ: เรียก API จริงเบื้องหลัง ไม่บล็อกหมวดอื่น
  loadSolar(c.lat, c.lng).catch((e) => console.warn('solar', e));
  loadForecast(c.lat, c.lng).catch((e) => console.warn('forecast', e));
  loadBurnScar(c.lat, c.lng).catch((e) => console.warn('burnscar', e));
}

const badge = (lv) => (lv ? `<span class="badge badge-${lv.style ?? lv}">${esc(lv.status ?? lv.label ?? '')}</span>` : '');
const km = (m) => (m == null ? '—' : m >= 1000 ? (m / 1000).toFixed(1) + ' กม.' : Math.round(m) + ' ม.');

function renderReport() {
  const rep = state.report; if (!rep) return;
  const cat = state.category;
  const head = `
    <div class="result-item">
      <span class="result-label">📍 พิกัดและที่ตั้ง</span><br>
      ${rep.lat.toFixed(6)}, ${rep.lng.toFixed(6)}<br>
      <span class="addr">🏠 ${esc(adminAddress(rep) ?? state.address ?? 'ไม่ทราบที่ตั้ง')}</span>${adminAddress(rep) && state.address ? `<br><small class="dim">OSM: ${esc(state.address)}</small>` : ''}
      <small class="dim">รายงานเมื่อ ${esc(core.fmtThaiDateTime(rep.generated_at))}</small>
    </div>
    <div class="result-item summary">${core.summarizeReport(rep).map((s) => `<div class="sum-line sum-${esc(s.level ?? '')}">• ${esc(s.text)}</div>`).join('')}</div>`;

  let body = '';
  if (cat === 'air') body = renderAir(rep);
  else if (cat === 'disaster') body = renderDisaster(rep);
  else if (cat === 'water') body = renderWater(rep);
  else if (cat === 'forest' || cat === 'eia') body = renderLayers(rep, cat);
  else if (cat === 'vegetation') body = `<div class="result-item">ชั้น NDVI จาก NASA GIBS (MODIS Terra 8 วัน) แสดงบนแผนที่แล้ว — ปรับความจางด้วยแถบเลื่อนด้านซ้าย<br><small class="dim">ค่า NDVI รายจุดต้องใช้ภาพดาวเทียมความละเอียดสูง (เฟสถัดไป)</small></div>`;
  else if (cat === 'solar') body = renderSolar(rep);
  else if (cat === 'weather') body = renderWeather(rep);
  $('panelBody').innerHTML = head + body;
  $('btnSave').hidden = !state.profile;
}

function renderAir(rep) {
  const a = rep.air, sat = rep.pm25_sat;
  if (!a) return `<div class="result-item">ไม่มีสถานี Air4Thai ใน 50 กม. จากจุดนี้${sat ? '' : ' และยังไม่มีข้อมูลดาวเทียม'}</div>` + (sat ? renderSat(sat) : '');
  const L = a.latest ?? {};
  const aqi = L.AQI?.value, lv = core.aqiLevel(aqi);
  const cell = (k, unit) => `<div class="cell"><span>${k}</span><b>${L[k]?.value ?? '—'}</b><small>${unit}</small></div>`;
  return `
    <div class="result-item">
      <span class="result-label">🌫️ สถานีใกล้สุด: ${esc(a.name_th)}</span> <span class="src">ห่าง ${km(a.distance_m)}</span><br>
      <small class="dim">${esc(a.area_th ?? '')} · ${esc(core.fmtThaiDateTime(a.observed_at))} (${esc(core.ago(a.observed_at))})</small>
      <div class="aqi-big" style="border-color:${lv.color}"><b style="color:${lv.color}">${aqi ?? '—'}</b><span>AQI · ${esc(lv.label)}</span></div>
      <div class="grid">${cell('PM25', 'µg/m³')}${cell('PM10', 'µg/m³')}${cell('O3', 'ppb')}${cell('NO2', 'ppb')}${cell('SO2', 'ppb')}${cell('CO', 'ppm')}</div>
      <small class="dim">ที่มา: กรมควบคุมมลพิษ (Air4Thai) · ค่าเฉลี่ยรายชั่วโมง</small>
    </div>` + (sat ? renderSat(sat) : '');
}
function renderSat(sat) {
  const pm = sat.latest?.PM25?.value, lv = core.pm25Level(pm);
  return `<div class="result-item"><span class="result-label">🛰️ PM2.5 จากดาวเทียม (GISTDA) จังหวัด${esc(sat.name_th)}</span><br>
    <b style="color:${lv.color}">${pm != null ? Number(pm).toFixed(1) : '—'}</b> µg/m³ · ${esc(lv.label)} <small class="dim">· ${esc(core.ago(sat.observed_at))} · ระดับจังหวัด</small></div>`;
}

function listItems(items, fmt, empty) {
  if (!items?.length) return `<div class="dim">${esc(empty)}</div>`;
  return `<ul class="lst">${items.slice(0, 12).map((x) => `<li>${fmt(x)}</li>`).join('')}${items.length > 12 ? `<li class="dim">…และอีก ${items.length - 12}</li>` : ''}</ul>`;
}
// ── รอยไหม้ GISTDA รอบจุด (±5 กม.) — เรียกผ่าน Edge, วาดโพลิกอนด้วย GeoJsonDataSource ──
async function loadBurnScar(lat, lng) {
  state.burn = { loading: true };
  if (state.category === 'disaster') renderReport();
  try { state.burn = await core.fetchBurnScar(lat, lng); } catch (e) { state.burn = { error: e.message }; }
  if (state.burnDs) { state.viewer.dataSources.remove(state.burnDs, true); state.burnDs = null; }
  if (state.burn?.features?.length) {
    try {
      state.burnDs = await Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: state.burn.features },
        { stroke: Cesium.Color.fromCssColorString('#ff6d00'), fill: Cesium.Color.fromCssColorString('#ff6d00').withAlpha(0.35), strokeWidth: 1, clampToGround: true });
      state.burnDs.show = state.category === 'disaster';
      state.viewer.dataSources.add(state.burnDs);
    } catch (e) { console.warn('burn polygons', e); }
  }
  if (state.category === 'disaster') renderReport();
}
function renderBurn() {
  const b = state.burn;
  if (!b || b.loading) return '<div class="result-item loading">🔄 กำลังขอรอยไหม้จาก GISTDA…</div>';
  if (b.error) return `<div class="result-item err">รอยไหม้: ${esc(b.error)}</div>`;
  return `<div class="result-item"><span class="result-label">🔥 รอยไหม้จากภาพดาวเทียม ใน 5 กม.</span> <span class="src">GISTDA${b.cached ? ' · แคช' : ''}</span><br>
    <b>${b.count}</b> แปลง · รวม <b>${b.area_rai}</b> ไร่${b.latest_period ? ` · ล่าสุด ${esc(core.fmtBurnPeriod(b.latest_period))}` : ''}
    ${b.by_landuse?.length ? `<ul class="lst">${b.by_landuse.map((x) => `<li>${esc(x.lu)} ${x.rai} ไร่</li>`).join('')}</ul>` : '<div class="dim">ไม่พบรอยไหม้ในรัศมี</div>'}
    <small class="dim">โพลิกอนสีส้มบนแผนที่ = รอยไหม้ (แสดงสูงสุด 60 แปลง) · สะสมทุกช่วงที่ GISTDA วิเคราะห์ ไม่ใช่เฉพาะปีนี้</small></div>`;
}

function renderDisaster(rep) {
  const h = rep.hotspots_7d_10km ?? {}, q = rep.quakes_30d_300km ?? {}, s = rep.landslides_10km ?? {}, f = rep.floods_30d_20km ?? {};
  const flood = (rep.layer_hits ?? []).find((x) => x.layer_id === 'gistda_flood_1d');
  return `
    <div class="result-item"><span class="result-label">🌊 น้ำท่วมจากภาพดาวเทียมวันนี้ (GISTDA)</span><br>
      ${flood ? `<b style="color:#2979ff">จุดนี้อยู่ในพื้นที่น้ำท่วม</b> (ภาพ ${esc(flood.props?.datetime ?? '')})` : '<span class="dim">จุดนี้ไม่อยู่ในพื้นที่น้ำท่วมที่ตรวจพบ (ชั้น gistda_flood_1d อัปเดตทุก 6 ชม.)</span>'}</div>
    ${renderBurn()}
    ${renderDisasterEvents(rep)}`;
}
function renderDisasterEvents(rep) {
  const h = rep.hotspots_7d_10km ?? {}, q = rep.quakes_30d_300km ?? {}, s = rep.landslides_10km ?? {}, f = rep.floods_30d_20km ?? {};
  return `
    <div class="result-item"><span class="result-label">🔥 จุดความร้อน 7 วัน ใน 10 กม.</span> <b>${h.count ?? 0}</b> จุด
      ${listItems(h.items, (x) => `${esc(core.fmtThaiDateTime(x.at))} · ห่าง ${km(x.distance_m)}${x.frp != null ? ' · FRP ' + x.frp : ''} <small class="dim">${esc(x.source)}</small>`, 'ไม่พบ — ที่มา GISTDA (MODIS/VIIRS)')}</div>
    <div class="result-item"><span class="result-label">🌍 แผ่นดินไหว 30 วัน ใน 300 กม.</span> <b>${q.count ?? 0}</b> ครั้ง
      ${listItems(q.items, (x) => `<b>M ${x.magnitude ?? '—'}</b> ${esc(x.title ?? '')} · ห่าง ${x.distance_km} กม. · ${esc(core.fmtThaiDateTime(x.at))}`, 'ไม่พบ — ที่มา กรมอุตุนิยมวิทยา')}</div>
    <div class="result-item"><span class="result-label">⛰️ ประวัติดินถล่ม ใน 10 กม.</span> <b>${s.count ?? 0}</b> จุด
      ${listItems(s.items, (x) => `${esc(x.title ?? 'ดินถล่ม')} · ห่าง ${km(x.distance_m)} · ${esc(core.fmtThaiDateTime(x.at))}`, 'ไม่พบ — ที่มา กรมทรัพยากรธรณี (ต้องนำเข้าไฟล์ก่อน)')}</div>
    ${f.count ? `<div class="result-item"><span class="result-label">🌊 เหตุการณ์น้ำท่วม 30 วัน ใน 20 กม.</span> <b>${f.count}</b> รายการ</div>` : ''}`;
}
function renderWater(rep) {
  const w = rep.wells_5km ?? {}, d = rep.dams_20km ?? {};
  return `<div class="result-item"><span class="result-label">🏞️ เขื่อน/อ่างเก็บน้ำ ใน 20 กม.</span> <b>${d.count ?? 0}</b> แห่ง
    ${listItems(d.items, (x) => `${esc(x.name ?? 'ไม่ระบุชื่อ')}${x.meta?.dam_type ? ` (${esc(x.meta.dam_type)})` : ''} · ห่าง ${km(x.distance_m)}`, 'ไม่พบ — ที่มา กรมทรัพยากรน้ำ (DAM)')}</div>
    <div class="result-item"><span class="result-label">💧 บ่อน้ำบาดาล ใน 5 กม.</span> <b>${w.count ?? 0}</b> บ่อ
    ${listItems(w.items, (x) => `${esc(x.name ?? x.area ?? 'บ่อ')} · ห่าง ${km(x.distance_m)}${x.meta?.depth_drill_m ? ` · ลึก ${x.meta.depth_drill_m} ม.` : ''}${x.meta?.yield_m3h ? ` · ${x.meta.yield_m3h} ลบ.ม./ชม.` : ''}`, 'ไม่พบ — ที่มา กรมทรัพยากรน้ำบาดาล (ทยอยดึงทุกชั่วโมง)')}</div>
    ${renderLayers(rep, 'water')}`;
}
/** ที่ตั้งจากชั้นขอบเขตการปกครอง (กรมการปกครอง 2556 ผ่าน DWR) — แม่นกว่า Nominatim และไม่ต้องยิงเน็ต */
function adminAddress(rep) {
  const hits = rep?.layer_hits ?? [];
  const tam = hits.find((x) => x.layer_id === 'dwr_tambon');
  const amp = hits.find((x) => x.layer_id === 'dwr_amphoe'), prov = hits.find((x) => x.layer_id === 'dwr_province');
  if (!tam && !amp && !prov) return null;
  // ฟิลด์ของ DWR มีคำนำหน้ามาแล้ว ("ต.เกาะนางคำ", "อ.เมืองปทุมธานี", "จ.ปทุมธานี") — ตัดก่อนแล้วเติมให้เป็นแบบเดียวกัน
  const strip = (s) => String(s ?? '').replace(/^(ต\.|อ\.|จ\.|แขวง|เขต|ตำบล|อำเภอ|จังหวัด)\s*/, '').trim();
  const p = strip(prov?.feature ?? amp?.props?.PROV_NAM_T ?? tam?.props?.PROV_NAM_T);
  const a = strip(amp?.feature ?? tam?.props?.AMPHOE_T);
  const t = strip(tam?.feature);
  const isBkk = /กรุงเทพ/.test(p);
  return [t && `${isBkk ? 'แขวง' : 'ต.'}${t}`, a && `${isBkk ? 'เขต' : 'อ.'}${a}`, p && (isBkk ? p : `จ.${p}`)].filter(Boolean).join(' ');
}

/** ชั้นโพลิกอนแยกตามแท็บ — ขอบเขตการปกครอง (dwr_province/amphoe) แสดงในหัวรายงานแทน */
const LAYER_GROUP = {
  forest: (id) => /^(rfd_|onep_|dnp_|ldd_)/.test(id),
  water: (id) => /^dwr_(main_basin|sub_basin|watershed)/.test(id),
  eia: (id) => /^(onep_eia|diw_|pcd_waste)/.test(id),
};
function renderLayers(rep, cat) {
  const hits = (rep.layer_hits ?? []).filter((x) => (LAYER_GROUP[cat] ?? (() => true))(x.layer_id));
  const title = { forest: '🌳 ชั้นป่าไม้/ที่ดินที่จุดนี้ตกอยู่', eia: '🏭 EIA / โรงงาน / ขยะ', water: '🗺️ ลุ่มน้ำ / ชั้นคุณภาพลุ่มน้ำ' }[cat];
  return `<div class="result-item"><span class="result-label">${title}</span>
    ${hits.length ? `<ul class="lst">${hits.map((x) => `<li><b>${esc(x.layer)}</b>${x.feature ? ' — ' + esc(x.feature) : ''}</li>`).join('')}</ul>`
                  : '<div class="dim">จุดนี้ไม่อยู่ในชั้นข้อมูลที่นำเข้าแล้ว (หรือยังไม่ได้นำเข้า — ใช้หน้า import.html)</div>'}
    ${cat === 'eia' ? '<small class="dim">EIA (สผ.) / โรงงาน (กรมโรงงานฯ) / ขยะ (คพ.) ไม่มี API — นำเข้า CSV ด้วยมือ แสดงป้าย "นำเข้าด้วยมือ"</small>' : ''}</div>`;
}
// ── สภาพอากาศ: พยากรณ์กริด 2 กม. ของกรมอุตุฯ ผ่าน Edge Function (token อยู่ฝั่งเซิร์ฟเวอร์) ──
async function loadForecast(lat, lng) {
  state.forecast = { loading: true };
  if (state.category === 'weather') renderReport();
  try { state.forecast = await core.fetchForecast(lat, lng); }
  catch (e) { state.forecast = { error: e.message }; }
  if (state.category === 'weather') renderReport();
}
const COND_ICON = { 1: '☀️', 2: '🌤️', 3: '⛅', 4: '☁️', 5: '🌦️', 6: '🌧️', 7: '🌧️', 8: '⛈️', 9: '🥶', 10: '🧊', 11: '🌬️', 12: '🥵' };
const hh = (iso) => new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
const dd = (iso) => new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short' });

function renderWeather(rep) {
  const fc = state.forecast;
  let out = '';
  if (!fc || fc.loading) out += '<div class="result-item loading">🔄 กำลังขอพยากรณ์จากกรมอุตุนิยมวิทยา…</div>';
  else if (fc.error) out += `<div class="result-item err">พยากรณ์ไม่ได้: ${esc(fc.error)}</div>`;
  else {
    const s = core.summarizeForecast(fc);
    const now = fc.hourly?.[0];
    out += `<div class="result-item"><span class="result-label">🌦️ พยากรณ์ ณ จุดนี้ (กริด 2 กม.)</span> <span class="src">กรมอุตุฯ NWP${fc.cached ? ' · แคช' : ''}</span><br>
      ${now ? `<div class="aqi-big" style="border-color:#42a5f5"><b style="color:#42a5f5">${COND_ICON[now.cond] ?? ''} ${now.tc ?? '—'}°</b><span>${esc(now.cond_th ?? '')} · ${hh(now.time)} น.<br><small class="dim">ความชื้น ${now.rh ?? '—'} % · ลม ${now.ws10m ?? '—'} m/s ${esc(core.windDir(now.wd10m))} · ฝน ${now.rain ?? 0} มม./ชม.</small></span></div>` : ''}
      ${s ? `<div class="sum-line">• 24 ชม. ข้างหน้า: ${s.tc_min}–${s.tc_max} °C · ฝนสะสม ${s.rain_mm} มม. · ${s.rainy_hours ? `มีฝน ${s.rainy_hours} ชม. เริ่ม ${hh(s.first_rain)} น.` : 'ไม่มีฝน'}</div>` : ''}
      <div class="hours">${(fc.hourly ?? []).slice(0, 24).map((x) => `<div class="hr" title="${esc(x.cond_th ?? '')}"><span>${hh(x.time).slice(0, 2)}</span><i>${COND_ICON[x.cond] ?? '·'}</i><b>${Math.round(x.tc)}°</b><small>${x.rain > 0 ? x.rain + 'มม' : ''}</small></div>`).join('')}</div>
    </div>
    <div class="result-item"><span class="result-label">📅 7 วันข้างหน้า</span>
      <table class="tbl"><tbody>${(fc.daily ?? []).map((x) => `<tr><td>${dd(x.time)}</td><td>${COND_ICON[x.cond] ?? ''} ${esc(x.cond_th ?? '')}</td><td>${Math.round(x.tc_min)}–${Math.round(x.tc_max)} °C</td><td>${x.rain ?? 0} มม.</td></tr>`).join('')}</tbody></table>
      <small class="dim">ที่มา: กรมอุตุนิยมวิทยา NWP API · กริดใกล้สุด ${fc.grid ? `${fc.grid.lat}, ${fc.grid.lon}` : ''} · ${esc(core.ago(fc.fetched_at))}</small></div>`;
  }
  const w = rep.weather;
  if (w) {
    const L = w.latest ?? {};
    out += `<div class="result-item"><span class="result-label">🌡️ ตรวจวัดจริง: ${esc(w.name_th)}</span> <span class="src">ห่าง ${km(w.distance_m)}</span><br>
      อุณหภูมิ <b>${L.tc?.value ?? '—'}</b> °C · ความชื้น ${L.rh?.value ?? '—'} % · ลม ${L.ws?.value ?? '—'} km/h · ฝน ${L.rain?.value ?? '—'} มม.<br>
      <small class="dim">${esc(core.fmtThaiDateTime(w.observed_at))} · ที่มา กรมอุตุนิยมวิทยา (สถานีตรวจอากาศ)</small></div>`;
  }
  return out;
}

// ── แสงอาทิตย์: NASA POWER + PVGIS จริง แทน getSourceData() เดิม ──────────────
async function loadSolar(lat, lng) {
  state.solar = { loading: true };
  if (state.category === 'solar') renderReport();
  const dt = new Date($('datetime').value || Date.now());
  const [np, pv, de] = await Promise.allSettled([
    core.withCache(core.cacheKey('nasa_power', lat, lng), () => core.fetchNasaPower(lat, lng), { sourceId: 'nasa_power' }),
    core.withCache(core.cacheKey(`pvgis:${dt.getMonth() + 1}-${dt.getHours()}`, lat, lng), () => core.fetchPvgisHour(lat, lng, dt.getMonth() + 1, dt.getHours()), { sourceId: 'pvgis' }),
    core.nearestStations(lat, lng, 15000, 'dede_solar', 1),          // แผนที่รังสีระดับตำบลของ พพ. (ในฐานข้อมูล)
  ]);
  state.solar = {
    nasa: np.status === 'fulfilled' ? np.value : { error: np.reason?.message },
    pvgis: pv.status === 'fulfilled' ? pv.value : { error: pv.reason?.message },
    dede: de.status === 'fulfilled' ? (de.value?.[0] ?? null) : null,
  };
  if (state.category === 'solar') renderReport();
}
function renderSolar() {
  const s = state.solar;
  if (!s || s.loading) return '<div class="result-item loading">🔄 กำลังเรียก NASA POWER และ PVGIS…</div>';
  const n = s.nasa?.payload, p = s.pvgis?.payload;
  // แผนที่รังสีอาทิตย์ระดับตำบลของ พพ. (พ.ศ. 2560, MJ/m²/วัน รายเดือน) — ข้อมูลไทยทางการ แสดงก่อน NASA
  const d = s.dede, dm = d?.meta ?? {};
  const MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const dede = d ? `
    <div class="result-item"><span class="result-label">🇹🇭 แผนที่ศักยภาพแสงอาทิตย์ พพ. (${esc(d.name_th)})</span> <span class="src">ห่าง ${km(d.distance_m)}</span><br>
      <b class="big">${dm.annual_kwh_m2 ?? '—'}</b> kWh/m²/ปี ${dm.annual_kwh_m2 ? badge(core.interpretGHI(dm.annual_kwh_m2)) : ''} · เฉลี่ย ${dm.annual_avg_mj ?? '—'} MJ/m²/วัน (${dm.annual_avg_kwh_day ?? '—'} kWh/m²/วัน)
      <div class="hours">${(dm.monthly ?? []).map((v, i) => `<div class="hr" title="${MON[i]} ${v ?? '—'} MJ/m²/วัน"><span>${MON[i]}</span><i style="display:block;width:16px;height:${Math.round(((v ?? 0) - 12) * 6)}px;background:#ffb300;border-radius:2px;margin-top:auto"></i><b>${v != null ? v.toFixed(1) : '—'}</b></div>`).join('')}</div>
      <small class="dim">ที่มา: กรมพัฒนาพลังงานทดแทนและอนุรักษ์พลังงาน ข้อมูลความเข้มรังสี พ.ศ. 2560 ระดับตำบล (CC BY) · ${esc(d.area_th ?? '')}</small></div>` : '';
  if (!n) return dede + `<div class="result-item err">NASA POWER: ${esc(s.nasa?.error ?? 'ไม่มีข้อมูล')}</div>`;
  const inst = p?.instantGhi ?? 800, ta = p?.airTemp ?? n.airTemp ?? 30, ws = p?.windSpeed ?? n.windSpeed ?? 1;
  const mt = core.moduleTemp({ instantGhi: inst, windSpeed: ws, airTemp: ta });
  return dede + `
    <div class="result-item"><span class="result-label">☀️ รังสีรวมแนวราบ GHI</span> <span class="src">NASA POWER ${n.year}${s.nasa.cached ? ' · แคช' : ''}</span><br>
      <b class="big">${n.ghi}</b> kWh/m²/ปี ${badge(core.interpretGHI(n.ghi))}<br><small class="dim">รวมจากค่ารายวัน ${n.days} วัน · กริด 0.5°</small></div>
    <div class="result-item"><span class="result-label">☁️ รังสีกระจาย (Diffuse)</span><br>
      <b class="big">${n.diffuse}</b> kWh/m²/ปี ${badge(core.interpretDiffuse(n.diffuse, n.ghi))}</div>
    <div class="result-item"><span class="result-label">🔥 อุณหภูมิแผงคาดการณ์ (King/Sandia)</span> <span class="src">${p ? 'PVGIS 5.3' : 'ประมาณ'}${s.pvgis?.cached ? ' · แคช' : ''}</span><br>
      <b class="big" style="color:#ff5252">${mt.toFixed(1)} °C</b> ${badge(core.interpretModuleTemp(mt))}
      <div class="vars">• G ชั่วขณะ ${inst} W/m² (${p ? `PVGIS เฉลี่ย ${p.samples} ชม. เดือน/ชั่วโมงที่เลือก` : 'ค่าประมาณ'})<br>• T_air ${ta} °C · ลม ${ws} m/s · ความชื้น ${n.humidity ?? '—'} %</div>
      ${s.pvgis?.error ? `<small class="dim">PVGIS: ${esc(s.pvgis.error)}</small>` : ''}</div>`;
}

// ════════════════════════════════════════════════════════════ ล็อกอิน / บันทึก

async function refreshProfile() {
  state.profile = await core.myProfile().catch(() => null);
  $('userBox').innerHTML = state.profile
    ? `<span>${esc(state.profile.email)} <small>(${esc(state.profile.role)})</small></span>
       ${core.canImport(state.profile.role) ? '<a href="import.html" class="lnk">นำเข้าไฟล์</a>' : ''}
       <button id="btnLogout" class="btn-sm">ออก</button>`
    : '<button id="btnLogin" class="btn-sm">เข้าสู่ระบบ</button> <small class="dim">ดูได้โดยไม่ต้องล็อกอิน · ล็อกอินเพื่อบันทึกผล</small>';
  $('btnLogin')?.addEventListener('click', () => { $('loginDlg').showModal(); });
  $('btnLogout')?.addEventListener('click', async () => { await core.signOut(); refreshProfile(); });
  $('btnSave').hidden = !state.profile || !state.report;
}

async function doLogin(ev) {
  ev.preventDefault();
  const r = await core.signIn($('loginEmail').value.trim(), $('loginPass').value);
  if (!r.ok) { $('loginErr').textContent = r.error; return; }
  $('loginErr').textContent = ''; $('loginDlg').close(); refreshProfile();
}

async function doSave() {
  if (!state.report) return;
  const name = prompt('ชื่อจุดวิเคราะห์', state.address ?? '');
  if (name === null) return;
  try {
    const id = await core.saveAssessment(name, state.lat, state.lng, { ...state.report, address: state.address, solar: state.solar ?? null });
    setStatus('บันทึกแล้ว (' + id.slice(0, 8) + ')', 'good');
  } catch (e) { setStatus('บันทึกไม่สำเร็จ: ' + e.message, 'crit'); }
}

// ════════════════════════════════════════════════════════════ เริ่มต้น

async function boot() {
  if (!core.isConfigured()) setStatus('ยังไม่ได้ตั้งค่า web/js/config.js — แผนที่ใช้ได้ แต่ข้อมูลจาก Supabase จะว่าง', 'warn');
  renderTabs();
  $('datetime').value = core.todayISO() + 'T12:00';
  await initMap();
  setCoords(DEFAULT_LAT, DEFAULT_LNG);
  $('btnAnalyze').addEventListener('click', analyze);
  $('coords').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
  $('btnClose').addEventListener('click', () => { $('resultPanel').hidden = true; });
  $('btnSave').addEventListener('click', doSave);
  $('loginForm').addEventListener('submit', doLogin);
  $('ndviOpacity').addEventListener('input', (e) => { $('opacityVal').textContent = Math.round(e.target.value * 100) + '%'; if (state.layers.gibs_ndvi) state.layers.gibs_ndvi.alpha = +e.target.value; });
  $('chkAqTile').addEventListener('change', (e) => { if (state.layers.gistda_aq) state.layers.gistda_aq.show = e.target.checked && state.category === 'air'; });
  $('btnRefresh').addEventListener('click', () => { drawAirStations(); drawEvents(); });

  core.onAuthChange((event) => { if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') refreshProfile(); });
  await Promise.allSettled([drawAirStations(), drawEvents()]);
  switchCategory('air');

  // แสดงเครดิตแหล่งข้อมูลจากทะเบียน (ข้อบังคับของสัญญาอนุญาต)
  try {
    state.sources = await core.listSources();
    $('credits').textContent = 'ที่มาข้อมูล: ' + [...new Set(state.sources.map((s) => s.agency))].join(' · ');
  } catch { $('credits').textContent = 'ที่มาข้อมูล: กรมควบคุมมลพิษ · GISTDA · กรมอุตุนิยมวิทยา · NASA · Esri'; }
}

boot().catch((e) => { console.error(e); setStatus('เริ่มระบบไม่สำเร็จ: ' + e.message, 'crit'); });
