/**
 * สร้างไฟล์ PowerPoint หัวข้อ 1–4 สำหรับส่งให้วิทยากรร่วมตรวจ จากเนื้อหาของ web/training-ai-netzero-2569.html
 *
 * ทำไมต้องมีไฟล์ PowerPoint ทั้งที่มีสไลด์ HTML อยู่แล้ว — ศ.กิติคุณ ดร.ธเรศ ต้องตรวจและแก้ถ้อยคำหัวข้อ 4
 * จึงต้องเป็นไฟล์ที่แก้ข้อความได้ในโปรแกรมที่ท่านใช้อยู่ ข้อความทุกส่วนจึงเป็นกล่องข้อความและตารางจริง
 * มีเฉพาะกราฟกับแผนภาพที่เป็นรูปภาพ เพราะวาดด้วย SVG ในหน้าเว็บ
 *
 * ใช้สองขั้น
 *   1) เปิด web/training-ai-netzero-2569.html ในเบราว์เซอร์ แล้วรันสคริปต์ดึงข้อมูลในคอนโซล
 *      เพื่อส่ง slides.json และรูป PNG ของกราฟทุกชิ้นไปเก็บไว้ในโฟลเดอร์ชั่วคราว
 *      (ต้องดึงจากเบราว์เซอร์เพราะกราฟและแผนภาพถูกสร้างด้วยจาวาสคริปต์ตอนแสดงผล)
 *   2) รันไฟล์นี้  NODE_PATH=<ที่ติดตั้ง pptxgenjs> node scripts/build_training_pptx.mjs
 *
 * ตรวจผลด้วย python-pptx (เปิดได้ไหม ชิ้นไหนล้นขอบ ข้อความครบไหม)
 * และเรนเดอร์เป็นภาพด้วย PowerPoint ผ่าน COM เพื่อดูด้วยตา เพราะเครื่องนี้ไม่มี LibreOffice
 */
import pptxgen from 'pptxgenjs';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyTheme } = require('C:/Users/Lenovo/AppData/Roaming/Claude/local-agent-mode-sessions/skills-plugin/0d97237f-68bc-4ac7-926b-6bf6856a6d81/17b58cdb-c83d-4569-9aa4-0c80ec39dc0a/skills/pptx/scripts/apply_theme.js');

const DIR = 'C:/Users/Lenovo/AppData/Local/Temp/claude/C--enterprise-envi-pi/544631c9-b2e8-4fc1-9406-eb4a8f8ebcbb/scratchpad/pptx';
const OUT = process.argv[2] || (DIR + '/อบรม-วสท-30ตค2569-หัวข้อ1-4.pptx');
const S = JSON.parse(readFileSync(DIR + '/slides.json', 'utf8'));

const FONT = 'Leelawadee UI';          // ฟอนต์ไทยที่ติดมากับ Windows 10 และ 11
const THEME = {
  name: 'envi_pi เขียวใบไม้',
  headFontFace: FONT, bodyFontFace: FONT,
  colors: {
    dk1: '1A1F1C', lt1: 'FFFFFF', dk2: '1B5E20', lt2: 'EEF3F0',
    accent1: '2E7D32', accent2: '15803D', accent3: 'A16207',
    accent4: 'BE123C', accent5: '1D4ED8', accent6: '4A5450',
    hlink: '1B5E20', folHlink: '4A5450',
  },
};
const HEX = { brand: '2E7D32', dark: '1B5E20', soft: 'E8F5E9', line: 'DDE5E0', ink: '1A1F1C', ink2: '4A5450', ink3: '7B8783',
  good: '15803D', goodBg: 'E7F6EC', warn: 'A16207', warnBg: 'FDF3D9', crit: 'BE123C', critBg: 'FDEAEF', info: '1D4ED8', infoBg: 'E8EEFC', surf2: 'F7FAF8' };
const KIND = { '': { bg: HEX.surf2, fg: HEX.dark }, ok: { bg: HEX.goodBg, fg: HEX.good }, warn: { bg: HEX.warnBg, fg: HEX.warn }, bad: { bg: HEX.critBg, fg: HEX.crit }, info: { bg: HEX.infoBg, fg: HEX.info } };
const BADGE = { 'ข้อมูลราชการไทย': HEX.good, 'คำนวณในสไลด์': HEX.brand, 'ค่าประมาณ': HEX.warn, 'วรรณกรรมสากล': HEX.info, 'ข้อมูลน่าสงสัย': HEX.crit };

const SEC = { t1: 'หัวข้อ 1 · AI กับงานวิศวกรรมสิ่งแวดล้อม', t2: 'หัวข้อ 2 · พลังงานสะอาดและโซลาร์เซลล์', t3: 'หัวข้อ 3 · การควบคุมด้วย AI แบบเรียลไทม์', t4: 'หัวข้อ 4 · Net Zero 2050' };

// ── พื้นที่ใช้งานของสไลด์ 13.3 × 7.5 นิ้ว ──
const X0 = 0.52, Y0 = 1.32, W = 12.26, YMAX = 6.44;
const GAP = 0.26;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.theme = { headFontFace: FONT, bodyFontFace: FONT };
pres.author = 'ดร.พีระพงษ์ ภัทรพันธุ์ชัย';
pres.title = 'อบรม วสท. · นวัตกรรม AI และพลังงานสะอาดเพื่องานวิศวกรรมสิ่งแวดล้อมสู่ Net Zero 2050';
pres.subject = 'เอกสารประกอบการอบรม 30 ตุลาคม 2569';
const C = pres.SchemeColor;

pres.defineSlideMaster({
  title: 'DIVIDER', background: { color: HEX.dark },
  objects: [
    { placeholder: { options: { name: 'num', type: 'body', x: 0.7, y: 0.7, w: 3, h: 1.9, fontSize: 118, bold: true, color: 'FFFFFF', align: 'left', valign: 'top' }, text: '' } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.7, y: 2.72, w: 11.9, h: 1.5, fontSize: 34, bold: true, color: 'FFFFFF', align: 'left', valign: 'top' }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.7, y: 4.32, w: 11.9, h: 2.2, fontSize: 15, color: 'D7EBD9', align: 'left', valign: 'top' }, text: '' } },
    { placeholder: { options: { name: 'clock', type: 'body', x: 0.7, y: 6.65, w: 11.9, h: 0.4, fontSize: 13, color: 'A5D6A7', align: 'left' }, text: '' } },
  ],
});
pres.defineSlideMaster({
  title: 'CONTENT', background: { color: 'FFFFFF' },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: X0, y: 0.34, w: 10.1, h: 0.86, fontSize: 25, bold: true, color: HEX.dark, align: 'left', valign: 'middle' }, text: '' } },
    { line: { x: X0, y: 1.21, w: W, h: 0, line: { color: HEX.brand, width: 2.25 } } },
    { text: { text: 'อบรม วสท. · 30 ตุลาคม 2569', options: { x: X0, y: 7.02, w: 6, h: 0.3, fontSize: 9, color: HEX.ink3, align: 'left', isTextBox: true } } },
  ],
  slideNumber: { x: 12.3, y: 7.02, w: 0.5, h: 0.3, fontSize: 9, color: HEX.ink3, align: 'right' },
});

// ── ประมาณความสูงของข้อความ เพื่อจัดบล็อกไม่ให้ล้นสไลด์ ──
const linesOf = (text, wIn, pt) => Math.max(1, Math.ceil((text || '').length / Math.max(6, wIn * 10.4 * (14 / pt))));
const hText = (text, wIn, pt) => linesOf(text, wIn, pt) * (pt * 1.42 / 72);

/** ข้อความทั้งหมดในกล่อง ยกเว้นตารางที่วาดแยก */
function cardBody(b) {
  const out = [];
  for (const p of b.parts || []) {
    if (p.k === 'table') continue;
    if (p.k === 'list') out.push(...p.items.map((t, i) => (p.ordered ? `${i + 1}. ` : '• ') + t));
    else if (p.text) out.push(p.text);
  }
  return out;
}
const cardTable = (b) => (b.parts || []).find((p) => p.k === 'table');
function hBlock(b, wIn) {
  // รูปใช้ความกว้างเต็มคอลัมน์ แต่ต้องไม่สูงเกินพื้นที่ · ถ้าสูงเกินให้ย่อตามความสูงแทน
  if (b.t === 'fig') return figBox(b.id, wIn).h + (b.cap ? hText(b.cap, wIn, 11) + 0.08 : 0);
  if (b.t === 'table') {
    const pt = tablePt(b);
    const cw = colW(b, wIn);
    const rowH = (txtRow) => Math.max(pt * 1.5 / 72 + 0.12, Math.max(...txtRow.map((c, i) => hText(c, cw[i], pt))) + 0.12);
    return rowH(b.head.length ? b.head : b.rows[0]) + b.rows.reduce((a, r) => a + rowH(r), 0) + 0.06;
  }
  if (b.t === 'kpi') return Math.ceil(b.items.length / 2) * 0.82;
  if (b.t === 'card') {
    const lines = cardBody(b).reduce((a, t) => a + hText(t, wIn - 0.42, 13) + 0.03, 0);
    const tbl = cardTable(b);
    return 0.24 + (b.h ? 0.28 : 0) + lines + (tbl ? hBlock(tbl.table, wIn - 0.42) + 0.08 : 0);
  }
  if (b.t === 'list') return b.items.reduce((a, t) => a + hText(t, wIn - 0.25, 13.5) + 0.06, 0) + 0.06;
  if (b.t === 'para') return hText(b.text, wIn, b.hint ? 11.5 : 14) + 0.1;
  if (b.t === 'group') {
    if (b.cols.length >= 3) {
      const cw = (wIn - 0.18) / 2; let h = 0;
      for (let i = 0; i < b.cols.length; i += 2) h += Math.max(hBlock(b.cols[i], cw), b.cols[i + 1] ? hBlock(b.cols[i + 1], cw) : 0) + 0.14;
      return h;
    }
    return b.cols.reduce((a, c) => a + hBlock(c, wIn) + 0.14, 0);
  }
  return 0.3;
}
const tablePt = (b) => { const n = Math.max(b.head.length, b.rows[0] ? b.rows[0].length : 1); return n >= 11 ? 8 : n >= 8 ? 9.5 : n >= 5 ? 11 : 12.5; };
/** ความกว้างคอลัมน์ตาราง · ต้องไม่แคบกว่าคำที่ยาวที่สุดในคอลัมน์ ไม่งั้นคำจะถูกตัดกลางคำ */
function colW(b, wIn) {
  const n = Math.max(b.head.length, b.rows[0] ? b.rows[0].length : 1);
  const score = new Array(n).fill(0), longest = new Array(n).fill(0);
  const feed = (r) => r.forEach((c, i) => {
    if (i >= n) return;
    const t = c || '';
    score[i] = Math.max(score[i] || 0, Math.min(60, t.length));
    const word = t.split(/[\s·]+/).reduce((a, w) => Math.max(a, w.length), 0);
    longest[i] = Math.max(longest[i] || 0, Math.min(26, word));
  });
  if (b.head.length) feed(b.head); b.rows.forEach(feed);
  const pt = tablePt(b), perChar = 1 / (10.4 * (14 / pt));   // นิ้วต่ออักษรโดยประมาณ
  const min = longest.map((w) => Math.max(0.5, (w + 1) * perChar));
  const base = score.map((v, i) => Math.max(min[i], wIn * Math.max(6, v) / score.reduce((a, x) => a + Math.max(6, x), 0)));
  const tot = base.reduce((a, v) => a + v, 0);
  return tot <= wIn ? base.map((v) => v + (wIn - tot) * v / tot) : base.map((v) => v * wIn / tot);
}

/** ขนาดที่รูปจะถูกวาง · เต็มความกว้างคอลัมน์ เว้นแต่จะสูงเกินพื้นที่ แล้วจึงย่อตามความสูง */
function figBox(id, wIn) {
  const r = FIGR[id] || 0.62, maxH = YMAX - Y0;
  return wIn * r <= maxH ? { w: wIn, h: wIn * r } : { w: maxH / r, h: maxH };
}
const FIGR = {}; // อัตราส่วนสูงต่อกว้างของรูปแต่ละชิ้น
for (const id of ['c1','c2','c3','c4','c5','c6','c7','c8','c9','c10','c11','c12','d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11']) {
  const p = `${DIR}/${id}.png`;
  if (!existsSync(p)) continue;
  const buf = readFileSync(p);
  FIGR[id] = buf.readUInt32BE(20) / buf.readUInt32BE(16); // ความสูง ÷ ความกว้าง จากส่วนหัว PNG
}

// ── วาดบล็อกลงสไลด์ ──
function draw(slide, b, x, y, w) {
  const h = hBlock(b, w);
  if (b.t === 'fig') {
    const p = `${DIR}/${b.id}.png`;
    const box = figBox(b.id, w);
    if (existsSync(p)) slide.addImage({ path: p, x: x + (w - box.w) / 2, y, w: box.w, h: box.h, objectName: 'ภาพ ' + b.id });
    if (b.cap) slide.addText(b.cap, { x, y: y + box.h + 0.05, w, h: hText(b.cap, w, 11), fontSize: 11, color: HEX.ink3, margin: 0, valign: 'top', isTextBox: true, objectName: 'คำบรรยายใต้ภาพ' });
    return box.h + (b.cap ? hText(b.cap, w, 11) + 0.08 : 0);
  }
  if (b.t === 'table') { drawTable(slide, b, x, y, w); return h; }
  if (b.t === 'kpi') {
    const perRow = b.items.length > 4 ? 3 : 2, bw = (w - (perRow - 1) * 0.14) / perRow;
    b.items.forEach((it, i) => {
      const cx = x + (i % perRow) * (bw + 0.14), cy = y + Math.floor(i / perRow) * 0.82;
      slide.addShape(pres.ShapeType.roundRect, { x: cx, y: cy, w: bw, h: 0.72, fill: { color: HEX.surf2 }, line: { color: HEX.line, width: 0.75 }, rectRadius: 0.06, objectName: 'ตัวเลขเด่น' });
      slide.addText([{ text: it.v, options: { fontSize: 19, bold: true, color: HEX.dark, breakLine: true } }, { text: it.l, options: { fontSize: 10, color: HEX.ink2 } }],
        { x: cx + 0.08, y: cy + 0.04, w: bw - 0.16, h: 0.64, margin: 0, valign: 'middle', isTextBox: true });
    });
    return Math.ceil(b.items.length / perRow) * 0.82;
  }
  if (b.t === 'card') {
    const k = KIND[b.kind] || KIND[''];
    slide.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: k.bg }, line: { color: k.fg, width: 0.75 }, rectRadius: 0.07, objectName: 'กล่องเนื้อหา' });
    const runs = [];
    if (b.h) runs.push({ text: b.h, options: { fontSize: 14, bold: true, color: k.fg, breakLine: true, paraSpaceAfter: 3 } });
    const parts = cardBody(b);
    parts.forEach((t, i) => runs.push({ text: t, options: { fontSize: 13, color: HEX.ink, breakLine: i < parts.length - 1, paraSpaceAfter: 2 } }));
    const tbl = cardTable(b);
    const textH = 0.2 + (b.h ? 0.28 : 0) + parts.reduce((a, t) => a + hText(t, w - 0.42, 13) + 0.03, 0);
    if (runs.length) slide.addText(runs, { x: x + 0.16, y: y + 0.13, w: w - 0.32, h: tbl ? textH : h - 0.26, margin: 0, valign: 'top', isTextBox: true });
    if (tbl) drawTable(slide, tbl.table, x + 0.16, y + textH + 0.06, w - 0.32);
    return h;
  }
  if (b.t === 'list') {
    slide.addText(b.items.map((t, i) => ({ text: t, options: { fontSize: 13.5, color: HEX.ink, bullet: b.ordered ? { type: 'number' } : true, breakLine: i < b.items.length - 1, paraSpaceAfter: 3 } })),
      { x, y, w, h, margin: 0, valign: 'top', isTextBox: true });
    return h;
  }
  if (b.t === 'para') {
    slide.addText(b.text, { x, y, w, h, fontSize: b.hint ? 11.5 : 14, color: b.hint ? HEX.ink3 : HEX.ink, margin: 0, valign: 'top', isTextBox: true });
    return h;
  }
  if (b.t === 'group') {
    if (b.cols.length >= 3) {
      const cw = (w - 0.18) / 2; let yy = y;
      for (let i = 0; i < b.cols.length; i += 2) {
        const h1 = draw(slide, b.cols[i], x, yy, cw);
        const h2 = b.cols[i + 1] ? draw(slide, b.cols[i + 1], x + cw + 0.18, yy, cw) : 0;
        yy += Math.max(h1, h2) + 0.14;
      }
      return yy - y;
    }
    let yy = y; for (const c of b.cols) yy += draw(slide, c, x, yy, w) + 0.14; return yy - y;
  }
  return 0;
}
function drawTable(slide, b, x, y, w) {
  const pt = tablePt(b), cw = colW(b, w);
  const rows = [];
  if (b.head.length) rows.push(b.head.map((t) => ({ text: t, options: { bold: true, color: HEX.dark, fill: { color: HEX.soft }, fontSize: pt } })));
  b.rows.forEach((r) => rows.push(r.map((t) => ({ text: t, options: { color: HEX.ink, fontSize: pt } }))));
  slide.addTable(rows, { x, y, w, colW: cw, border: { type: 'solid', color: HEX.line, pt: 0.5 }, fontFace: FONT, fontSize: pt, valign: 'top', margin: 0.04, objectName: 'ตาราง' });
}

// ── ประกอบสไลด์ ──
let made = 0, cont = 0;
let curSec = null;
for (const s of S) {
  if (s.sec !== curSec) { curSec = s.sec; pres.addSection({ title: SEC[s.sec] }); }

  if (s.divider) {
    const sl = pres.addSlide({ masterName: 'DIVIDER', sectionTitle: SEC[s.sec] });
    sl.addText(s.num || '', { placeholder: 'num' });
    sl.addText(s.h2.replace(/\s+/g, ' '), { placeholder: 'title' });
    sl.addText((s.intro || []).map((t, i) => ({ text: t, options: { bullet: { type: 'number' }, breakLine: i < s.intro.length - 1, paraSpaceAfter: 7 } })), { placeholder: 'body' });
    sl.addText(s.clock || '', { placeholder: 'clock' });
    if (s.notes) sl.addNotes(s.notes);
    made++;
    continue;
  }

  // จัดบล็อกลงคอลัมน์ ถ้าล้นให้ไหลไปสไลด์ต่อเนื่อง
  // กลุ่มกล่องหลายใบต้องแตกเป็นบล็อกเดี่ยวก่อนจัดหน้า ไม่งั้นทั้งกลุ่มถูกวางรวดเดียวจนล้นท้ายแผ่น
  const expand = (arr) => {
    const out = arr.flatMap((b) => (b.t === 'group' && b.cols.length >= 3) ? b.cols : [b]);
    // คำบรรยายใต้รูปต้องไปพร้อมรูปเสมอ ไม่งั้นจะหลุดไปลอยอยู่คนละแผ่น
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].t === 'fig' && out[i + 1].t === 'para' && out[i + 1].hint) { out[i] = { ...out[i], cap: out[i + 1].text }; out.splice(i + 1, 1); }
    }
    return out;
  };
  const flat0 = s.flat ? expand(s.flat) : null;
  const cols0 = s.cols ? s.cols.map(expand) : null;
  // ตารางกว้างหรือรูปกว้างต้องได้ความกว้างเต็มแผ่น อย่าบีบลงครึ่งเดียว
  const wideBlock = (flat0 || []).some((b) => (b.t === 'table' && Math.max(b.head.length, b.rows[0] ? b.rows[0].length : 0) >= 4) || (b.t === 'fig' && (FIGR[b.id] || 1) < 0.5));
  const ncol = s.layout === 'cols-4' ? 4 : s.layout === 'cols-3' ? 3 : cols0 ? 2 : (flat0 && flat0.length >= 4 && !wideBlock ? 2 : 1);
  // คอลัมน์ที่มีรูปควรกว้างกว่า ตามสัดส่วนเดียวกับสไลด์ต้นฉบับ
  const hasFig = (q) => q.some((b) => b.t === 'fig');
  let widths;
  if (ncol === 2) {
    const big = s.wide === 'l' || (cols0 && hasFig(cols0[0]) && !hasFig(cols0[1])) ? 0
      : s.wide === 'r' || (cols0 && hasFig(cols0[1]) && !hasFig(cols0[0])) ? 1 : -1;
    const avail = W - GAP;
    widths = big < 0 ? [avail / 2, avail / 2] : big === 0 ? [avail * 0.575, avail * 0.425] : [avail * 0.425, avail * 0.575];
  } else {
    widths = new Array(ncol).fill((W - (ncol - 1) * GAP) / ncol);
  }
  const xOf = (i) => X0 + widths.slice(0, i).reduce((a, v) => a + v + GAP, 0);

  let queues = cols0 ? cols0.map((c) => c.slice()) : [ (flat0 || []).slice() ];
  while (queues.length < ncol) queues.push([]);
  if (queues.length > ncol) { const extra = queues.splice(ncol); extra.forEach((q, i) => queues[i % ncol].push(...q)); }

  let part = 0;
  while (queues.some((q) => q.length)) {
    // เนื้อหาที่กองอยู่คอลัมน์เดียว ให้เกลี่ยลงทุกคอลัมน์ ไม่งั้นได้แผ่นที่ว่างครึ่งหนึ่ง
    // สไลด์ที่ต้นฉบับแบ่งคอลัมน์ไว้เองจะเกลี่ยเฉพาะแผ่นต่อเนื่อง เพื่อรักษาการจับคู่ซ้าย-ขวาของแผ่นแรก
    if ((part > 0 || !cols0) && ncol > 1 && queues.filter((q) => q.length).length === 1) {
      const src = queues.find((q) => q.length);
      if (src.length >= ncol) {
        const items = src.splice(0, src.length);
        const tot = items.reduce((a, b) => a + hBlock(b, widths[0]), 0);
        let acc = 0, ci = 0;
        for (const b of items) {
          queues[ci].push(b);
          acc += hBlock(b, widths[ci]);
          if (ci < ncol - 1 && acc >= tot * (ci + 1) / ncol) ci++;
        }
      }
    }
    const sl = pres.addSlide({ masterName: 'CONTENT', sectionTitle: SEC[s.sec] });
    sl.addText(s.h2 + (part ? ' (ต่อ)' : ''), { placeholder: 'title' });
    if (s.badges.length) {
      sl.addText(s.badges.map((t, i) => ({ text: ' ' + t + ' ', options: { color: BADGE[t] || HEX.ink2, breakLine: i < s.badges.length - 1 } })),
        { x: 10.7, y: 0.42, w: 2.1, h: 0.7, fontSize: 10.5, bold: true, align: 'right', valign: 'middle', margin: 0, isTextBox: true, objectName: 'ป้ายที่มา' });
    }
    let any = false;
    queues.forEach((q, ci) => {
      let y = Y0, x = xOf(ci);
      const colw = widths[ci];
      while (q.length) {
        let h = hBlock(q[0], colw);
        // ตารางที่สูงเกินพื้นที่ให้ตัดเป็นสองท่อน ท่อนหลังขึ้นแผ่นใหม่พร้อมหัวตารางเดิม
        if (q[0].t === 'table' && y + h > YMAX && q[0].rows.length > 2) {
          const b0 = q[0], avail = YMAX - y, cw = colW(b0, colw), pt = tablePt(b0);
          const rowH = (r) => Math.max(pt * 1.5 / 72 + 0.12, Math.max(...r.map((c, i) => hText(c, cw[i], pt))) + 0.12);
          let used = b0.head.length ? rowH(b0.head) : 0, keep = 0;
          while (keep < b0.rows.length && used + rowH(b0.rows[keep]) <= avail) { used += rowH(b0.rows[keep]); keep++; }
          if (keep >= 2 && keep < b0.rows.length) {
            const rest = { t: 'table', head: b0.head, rows: b0.rows.slice(keep) };
            q[0] = { t: 'table', head: b0.head, rows: b0.rows.slice(0, keep) };
            q.splice(1, 0, rest);
            h = hBlock(q[0], colw);
          }
        }
        // บล็อกสุดท้ายที่เหลือทั้งสไลด์ ถ้าเกินมาเล็กน้อยให้วางต่อเลย ดีกว่าได้แผ่นใหม่ที่มีของชิ้นเดียว
        const lastOne = queues.reduce((a, qq) => a + qq.length, 0) === 1;
        if (y + h > YMAX && y > Y0 && !(lastOne && y + h <= YMAX + 0.85)) break;
        const b = q.shift();
        y += draw(sl, b, x, y, colw) + 0.16;
        any = true;
      }
    });
    if (!any) { queues.forEach((q) => q.shift()); }   // กันลูปไม่รู้จบถ้าบล็อกเดียวสูงเกินสไลด์
    if (s.src && !queues.some((q) => q.length)) {
      sl.addText('ที่มา · ' + s.src, { x: X0, y: 6.66, w: W, h: 0.34, fontSize: 8.5, color: HEX.ink3, margin: 0, valign: 'top', isTextBox: true, objectName: 'ที่มาของข้อมูล' });
    }
    if (s.notes && !part) sl.addNotes(s.notes);
    made++; if (part) cont++;
    part++;
    if (part > 4) break;
  }
}

await pres.writeFile({ fileName: OUT });
await applyTheme(OUT, THEME);
console.log('สร้างไฟล์แล้ว:', OUT);
console.log('สไลด์ทั้งหมด', made, 'แผ่น · ในจำนวนนี้เป็นแผ่นต่อเนื่อง', cont, 'แผ่น · จากต้นฉบับ', S.length, 'แผ่น');
