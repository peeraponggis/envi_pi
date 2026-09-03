/**
 * ดึงชั้นข้อมูลจาก ArcGIS REST MapServer/FeatureServer เป็น GeoJSON (WGS84) ทั้งชั้น
 *
 *   node scripts/fetch_arcgis.mjs <layer-url> <out.geojson> [where]
 *   เช่น node scripts/fetch_arcgis.mjs "https://gis.dwr.go.th/arcgis/rest/services/Sub_Basin/MapServer/0" data/raw/dwr_sub_basin.geojson
 *
 * แบ่งหน้าอัตโนมัติ: ถ้าเลเยอร์รองรับ pagination ใช้ resultOffset · ถ้าไม่รองรับ (GISTDA, บางชั้นของ DWR)
 * ใช้ where <OID> > <ค่าสูงสุดของหน้าก่อน> — วิธีเดียวกับ Edge Function envi-ingest
 * ที่มา: gis.dwr.go.th เปิดสาธารณะ (ตรวจ 3 ก.ย. 2569) — เก็บ URL ต้นทางไว้ใน properties ของ FeatureCollection
 */
import fs from 'node:fs';

const [layerUrl, outPath, whereArg = '1=1'] = process.argv.slice(2);
if (!layerUrl || !outPath) { console.error('ใช้: node scripts/fetch_arcgis.mjs <layer-url> <out.geojson> [where]'); process.exit(1); }

const meta = await (await fetch(`${layerUrl}?f=json`)).json();
if (meta.error) throw new Error('metadata: ' + JSON.stringify(meta.error));
const oid = meta.objectIdField || (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
const paging = meta.advancedQueryCapabilities?.supportsPagination === true;
const pageSize = Math.min(meta.maxRecordCount || 1000, 2000);
console.log(`${meta.name}: ${meta.geometryType} · oid=${oid} · pagination=${paging} · maxRecordCount=${meta.maxRecordCount}`);

const features = [];
let offset = 0, lastOid = -1;
for (let page = 0; page < 500; page++) {
  const where = paging || lastOid < 0 ? whereArg : `(${whereArg}) AND ${oid} > ${lastOid}`;
  const params = new URLSearchParams({ where, outFields: '*', outSR: '4326', f: 'geojson', returnGeometry: 'true' });
  if (paging) { params.set('resultOffset', String(offset)); params.set('resultRecordCount', String(pageSize)); }
  const r = await fetch(`${layerUrl}/query?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error('query: ' + JSON.stringify(j.error));
  const feats = j.features || [];
  features.push(...feats);
  process.stdout.write(`  หน้า ${page + 1}: +${feats.length} (รวม ${features.length})\n`);
  if (feats.length === 0) break;
  if (paging) {
    offset += feats.length;
    if (!j.exceededTransferLimit && !(j.properties?.exceededTransferLimit) && feats.length < pageSize) break;
  } else {
    let mx = lastOid;
    for (const f of feats) { const v = Number(f.properties?.[oid] ?? f.id); if (Number.isFinite(v) && v > mx) mx = v; }
    if (mx === lastOid || feats.length < pageSize) break;
    lastOid = mx;
  }
}

const out = { type: 'FeatureCollection', name: meta.name, source_url: layerUrl, fetched_at: new Date().toISOString(), features };
fs.writeFileSync(outPath, JSON.stringify(out));
const types = {};
for (const f of features) types[f.geometry?.type] = (types[f.geometry?.type] || 0) + 1;
console.log(`เขียน ${outPath}: ${features.length} ฟีเจอร์ ${JSON.stringify(types)} ${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB`);
