/**
 * ดึงทะเบียนโครงการ EIA/IEE จาก Smart EIA Plus (สผ.) — https://eia.onep.go.th/site/eia
 *
 * ทำไมต้อง scrape: สผ. ไม่มี API/CSV สาธารณะ (ตรวจ 3 ก.ย. 2569: /services/web/eia/list ตอบ 401)
 * หน้ารายการเป็นฟอร์ม POST (100 แถว/หน้า, มี CSRF) และที่ตั้ง (ตำบล/อำเภอ/จังหวัด) อยู่ในหน้ารายละเอียดเท่านั้น
 * → 1) POST รายการทีละหน้าเก็บ id/ชื่อ/ประเภท/สถานะ  2) GET รายละเอียดทีละโครงการเก็บที่ตั้ง (พร้อมกันไม่เกิน 4, หน่วง 250 ms)
 * ข้อมูลเป็นทะเบียนสาธารณะของราชการ ใช้เพื่อแสดงผล ไม่ดัดแปลง · ระบุ User-Agent ให้เจ้าของระบบติดต่อได้
 *
 *   node scripts/scrape_eia.mjs list            → data/raw/eia_list.json
 *   node scripts/scrape_eia.mjs detail [limit]  → data/raw/eia_detail.json (เขียนต่อจากที่มีอยู่ รันซ้ำได้)
 */
import fs from 'node:fs';

const BASE = 'https://eia.onep.go.th';
const UA = 'envi-pi/1.0 (+https://github.com/peeraponggis/envi_pi; open-data aggregation)';
const OUT_LIST = 'data/raw/eia_list.json', OUT_DETAIL = 'data/raw/eia_detail.json';
const mode = process.argv[2] ?? 'list';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

async function session() {
  const r = await fetch(`${BASE}/site/eia`, { headers: { 'User-Agent': UA } });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const html = await r.text();
  const csrf = html.match(/name="eia_csrf-frontend"\s+value="([^"]+)"/)?.[1] ?? html.match(/csrf-token"\s+content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('ไม่พบ CSRF token');
  return { cookie, csrf };
}

function parseList(html) {
  const rows = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    const id = tr.match(/detail\?id=(\d+)/)?.[1];
    if (!id || tds.length < 8) continue;
    rows.push({ id: +id, name: tds[2], category: tds[3], report_no: tds[4], status: tds[5], approval_no: tds[6], approval_date: tds[7] });
  }
  const last = Math.max(0, ...[...html.matchAll(/page="(\d+)"/g)].map((m) => +m[1]));
  return { rows, last };
}

async function listAll() {
  const s = await session();
  const all = [];
  let page = 1, last = 1;
  while (page <= last) {
    const body = new URLSearchParams({ 'eia_csrf-frontend': s.csrf, page: String(page), name: '', province_id: '', category_id: '', status_id: '' });
    const r = await fetch(`${BASE}/site/eia`, { method: 'POST', headers: { 'User-Agent': UA, Cookie: s.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const html = await r.text();
    const { rows, last: l } = parseList(html);
    if (page === 1) last = l || 1;
    if (rows.length === 0) { console.log(`หน้า ${page}: ว่าง หยุด`); break; }
    all.push(...rows);
    process.stdout.write(`หน้า ${page}/${last}: +${rows.length} (รวม ${all.length})\n`);
    page++;
    await sleep(300);
  }
  const uniq = [...new Map(all.map((x) => [x.id, x])).values()];
  fs.writeFileSync(OUT_LIST, JSON.stringify(uniq));
  console.log(`เขียน ${OUT_LIST}: ${uniq.length} โครงการ`);
}

function parseDetail(html) {
  const text = strip(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<\/(div|p|tr|td|li|h\d)>/g, '\n'));
  const grab = (label) => { const m = text.match(new RegExp(label + '\\s*:\\s*(.*?)(?=\\s+[ก-๙A-Za-z(][^:]{2,40}\\s*:|$)')); return m ? m[1].trim() : null; };
  const loc = grab('ที่ตั้งโครงการ') ?? '';
  const lm = loc.match(/(?:ตำบล|แขวง)\s*([^\s]+)?\s*(?:อำเภอ|เขต)\s*([^\s]+)?\s*จังหวัด\s*([^\s\d]+)?\s*(\d{5})?/);
  return {
    report_type: grab('ประเภทรายงาน'), category: grab('ประเภทโครงการ'), subcategory: grab('ประเภทโครงการรอง'),
    location: loc || null, tambon: lm?.[1] ?? null, amphoe: lm?.[2] ?? null, province: lm?.[3] ?? null, postcode: lm?.[4] ?? null,
    consultant: grab('นิติบุคคลผู้ทำรายงาน'), owner: grab('เจ้าของโครงการ'), project_status: grab('สถานภาพของโครงการ'),
    approval_no: grab('เลขที่หนังสือเห็นชอบ'), approval_date: grab('วันที่แจ้งเห็นชอบ'),
  };
}

async function detailAll(limit = Infinity) {
  const list = JSON.parse(fs.readFileSync(OUT_LIST, 'utf8'));
  const done = fs.existsSync(OUT_DETAIL) ? JSON.parse(fs.readFileSync(OUT_DETAIL, 'utf8')) : {};
  const todo = list.filter((x) => !done[x.id]).slice(0, limit);
  console.log(`รายละเอียด: ทำแล้ว ${Object.keys(done).length} · เหลือ ${todo.length}`);
  let i = 0, fail = 0;
  const worker = async () => {
    while (i < todo.length) {
      const item = todo[i++];
      try {
        const r = await fetch(`${BASE}/eia/detail?id=${item.id}`, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        done[item.id] = parseDetail(await r.text());
      } catch (e) { fail++; done[item.id] = { error: String(e.message) }; }
      if (i % 100 === 0) { fs.writeFileSync(OUT_DETAIL, JSON.stringify(done)); process.stdout.write(`  ${i}/${todo.length} (ล้ม ${fail})\n`); }
      await sleep(250);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  fs.writeFileSync(OUT_DETAIL, JSON.stringify(done));
  console.log(`เขียน ${OUT_DETAIL}: ${Object.keys(done).length} โครงการ · ล้ม ${fail}`);
}

if (mode === 'list') await listAll();
else if (mode === 'detail') await detailAll(Number(process.argv[3]) || Infinity);
else console.error('ใช้: list | detail [limit]');
