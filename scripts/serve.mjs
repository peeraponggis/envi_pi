/**
 * เซิร์ฟเวอร์สถิตสำหรับเปิดหน้าเว็บตอนพัฒนา — ไม่ต้องลงอะไรเพิ่ม (คัดจาก pi_crm_erp/scripts/serve.mjs)
 *
 *   node scripts/serve.mjs          → http://127.0.0.1:5500/web/index.html
 *   node scripts/serve.mjs 8080     → เปลี่ยนพอร์ต
 *
 * ต้องเปิดผ่าน http:// เท่านั้น — ES Modules ถูกบล็อกบน file://
 * เสิร์ฟจากโฟลเดอร์ envi_pi ทั้งก้อน
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 5500;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end('URL ไม่ถูกต้อง'); return; }
  if (rel === '/') { res.writeHead(302, { Location: '/web/index.html' }).end(); return; }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('ห้ามออกนอกโฟลเดอร์'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`ไม่พบไฟล์: ${rel}`); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`เสิร์ฟ ${ROOT}`);
  console.log(`  แผนที่   → http://127.0.0.1:${PORT}/web/index.html`);
  console.log(`  นำเข้า   → http://127.0.0.1:${PORT}/web/import.html`);
});
