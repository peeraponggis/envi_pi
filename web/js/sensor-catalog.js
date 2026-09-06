/**
 * ฐานความรู้ + สูตรของ "ระบบออกแบบเซนเซอร์และพลังงานสำหรับระบบบำบัดน้ำเสีย" (ไม่แตะ DOM/เครือข่าย · ทดสอบด้วย node --test)
 *
 * ⚠️ ค่าทั้งหมดที่เป็นพลังงาน ราคา kWh/m³ PR ต้นทุน เป็น **ค่าประมาณเพื่อวางแผนเบื้องต้น** (ทุก record มี estimate:true + source)
 *    แบรนด์/รุ่นเป็น "ตัวอย่างข้อมูลสาธารณะ" ไม่ใช่การรับรอง ผู้ใช้ต้องยืนยันเอกสารรับรองรุ่นจริงกับผู้จำหน่าย
 * ใช้ร่วมกับ web/js/param-info.js (เกณฑ์ราชการ) — พารามิเตอร์เชิงเดินระบบ (MLSS, ORP, Level, in:BOD …) อยู่ใน EXTRA_PARAM_INFO ที่นี่
 */
import { PARAM_INFO, PLANT_TYPE, levelOf, infoKey } from './param-info.js';

export const CATALOG_VERSION = '2026-09-06';
const EST = (source) => ({ estimate: true, source });

/** พารามิเตอร์เพิ่มเติมสำหรับควบคุมกระบวนการ (ไม่มีในเกณฑ์ราชการ) — โครงเดียวกับ PARAM_INFO */
export const EXTRA_PARAM_INFO = {
  MLSS: { name: 'ตะกอนแขวนลอยในถังเติมอากาศ (MLSS)', unit: 'mg/L', desc: 'ความเข้มข้นจุลินทรีย์ในถังเติมอากาศ ใช้ควบคุมการทิ้งตะกอน/อายุตะกอน', std: 'ช่วงควบคุมทั่วไป AS 2,500–4,000 mg/L · OD 3,000–5,000 · MBR 8,000–12,000', dir: 'range', lines: [{ v: 2500, l: 'ต่ำสุด 2,500' }, { v: 4000, l: 'สูงสุด 4,000' }], bands: [['good', '2,500 – 4,000'], ['fair', '1,500 – 2,499 หรือ 4,001 – 5,000'], ['bad', 'นอกช่วง']] },
  ORP: { name: 'ศักย์ออกซิเดชัน-รีดักชัน (ORP)', unit: 'mV', desc: 'บอกสภาวะในถัง: > +50 mV ใช้ออกซิเจน · −50…+50 แอนอกซิก (ดีไนตริฟิเคชัน) · < −100 ไร้อากาศ', std: 'ไม่มีมาตรฐาน ใช้ควบคุมกระบวนการ', dir: 'none', lines: [{ v: 50, l: 'aerobic > +50' }, { v: -100, l: 'anaerobic < −100' }], bands: [] },
  Level: { name: 'ระดับน้ำ', unit: 'm', desc: 'ระดับน้ำในบ่อสูบ/บ่อพัก/รางวัด ใช้ควบคุมปั๊มและคำนวณอัตราไหลรางเปิด', std: 'ตามการออกแบบแต่ละบ่อ', dir: 'none', lines: [], bands: [] },
  'in:BOD': { name: 'บีโอดีน้ำเข้า (BOD)', unit: 'mg/L', desc: 'ภาระสารอินทรีย์ที่เข้าระบบ ใช้คิดภาระ (kg BOD/วัน) และประสิทธิภาพกำจัด', std: 'น้ำเสียชุมชนไทยทั่วไป 80–250 mg/L', dir: 'none', lines: [], bands: [] },
  'in:COD': { name: 'ซีโอดีน้ำเข้า (COD)', unit: 'mg/L', desc: 'ภาระสารอินทรีย์รวมที่เข้าระบบ', std: 'ชุมชน 150–500 · โรงงานต่างกันมาก', dir: 'none', lines: [], bands: [] },
  'in:TSS': { name: 'สารแขวนลอยน้ำเข้า (TSS)', unit: 'mg/L', desc: 'ตะกอนในน้ำเข้า ใช้ประเมินภาระตะกอนและตะแกรง/บ่อตกตะกอนขั้นต้น', std: 'ชุมชน 100–350 mg/L', dir: 'none', lines: [], bands: [] },
  Temp: PARAM_INFO.Temp,
  Rain: { name: 'ปริมาณฝน', unit: 'mm', desc: 'ฝนตกทำให้น้ำเข้าเพิ่มฉับพลัน (ท่อรวม) ใช้เตือนล่วงหน้า', std: 'ไม่มีมาตรฐาน', dir: 'none', lines: [], bands: [] },
};
export const ALL_PARAM_INFO = { ...PARAM_INFO, ...EXTRA_PARAM_INFO };
export const paramInfo = (key) => ALL_PARAM_INFO[key] ?? null;
/** ระดับของค่าตามพารามิเตอร์ (รวม EXTRA) */
export function levelFor(key, v) {
  if (v == null || isNaN(v)) return 'none';
  if (key === 'MLSS') return v >= 2500 && v <= 4000 ? 'good' : v >= 1500 && v <= 5000 ? 'fair' : 'bad';
  if (PARAM_INFO[key]) return levelOf(key, v);
  return 'none';
}

/** ขั้นตอนของกระบวนการ (ใช้วาดแผนภาพ) */
export const STAGES = {
  inlet: { name: 'น้ำเข้า', icon: '⬇️' }, screen: { name: 'ตะแกรง/ดักกรวด', icon: '🧱' }, eq: { name: 'บ่อปรับสมดุล', icon: '🫧' }, pump: { name: 'บ่อสูบ', icon: '⚙️' },
  primary: { name: 'ตกตะกอนขั้นต้น', icon: '🔻' }, aeration: { name: 'ถังเติมอากาศ', icon: '💨' }, anoxic: { name: 'ถังแอนอกซิก', icon: '🌀' }, anaerobic: { name: 'ถังไร้อากาศ', icon: '🛢️' },
  pond1: { name: 'บ่อแรก (แอนแอโรบิก/แฟคัลเททีฟ)', icon: '🟤' }, pond2: { name: 'บ่อบ่ม (แมทูเรชัน)', icon: '🟢' }, lagoon: { name: 'สระเติมอากาศ', icon: '🌊' },
  ditch: { name: 'คลองวนเวียน', icon: '🔁' }, wetland: { name: 'บึงประดิษฐ์', icon: '🌿' }, rbc: { name: 'จานหมุนชีวภาพ', icon: '⚪' }, sbr: { name: 'ถัง SBR', icon: '⏱️' }, membrane: { name: 'เมมเบรน', icon: '🧫' },
  clarifier: { name: 'ตกตะกอนขั้นสอง', icon: '🔽' }, disinfect: { name: 'ฆ่าเชื้อ', icon: '🧪' }, outlet: { name: 'น้ำทิ้งออก', icon: '⬆️' }, sludge: { name: 'จัดการตะกอน', icon: '🪣' }, plant: { name: 'ทั้งโรง', icon: '🏭' },
};

const M = (stage, param, o = {}) => ({ stage, param, required: false, ...o });
const COMMON_IN = [M('inlet', 'Flow', { required: true, note: 'รางเปิด/ท่อรับน้ำ ใช้คิดภาระและค่าธรรมเนียม' }), M('inlet', 'PH', { note: 'เตือนน้ำเสียผิดปกติ (กรด/ด่างจากโรงงาน)' }), M('inlet', 'in:COD', { note: 'UV-VIS ประเมินภาระเข้าต่อเนื่อง' })];
const COMMON_OUT = [M('outlet', 'Flow', { required: true }), M('outlet', 'PH', { required: true }), M('outlet', 'eff:BOD', { required: true, note: 'มาตรฐานน้ำทิ้งชุมชน ≤ 20 mg/L' }), M('outlet', 'eff:COD'), M('outlet', 'eff:TSS', { required: true }), M('outlet', 'NH4N'), M('plant', 'Watt', { required: true, note: 'มิเตอร์ไฟรวม แยกวงจรเซนเซอร์' })];
const sim = (o) => o;

/** ประเภทระบบบำบัด → ขั้นตอน, จุดวัดที่ควรมี, benchmark พลังงาน, พารามิเตอร์จำลอง */
export const PROCESS_TYPES = {
  AS: { code: 'AS', name: PLANT_TYPE.AS, kind: 'community', stages: ['inlet', 'screen', 'primary', 'aeration', 'clarifier', 'disinfect', 'outlet', 'sludge'],
    monitor: [...COMMON_IN, M('aeration', 'DO', { required: true, target: [1.5, 3], note: 'ควบคุมเครื่องเติมอากาศ (ประหยัดไฟ 15–30%)' }), M('aeration', 'MLSS', { required: true, target: [2500, 4000] }), M('aeration', 'ORP'), M('clarifier', 'Level', { note: 'ระดับตะกอน (sludge blanket)' }), ...COMMON_OUT],
    energy: { kwh_m3: [0.3, 0.6], ...EST('ช่วงอ้างอิงวรรณกรรม AS ทั่วไป 0.3–0.6 kWh/m³ (ค่าประมาณ) — เครื่องเติมอากาศ 50–70% ของไฟทั้งโรง') },
    sim: { DO: sim({ base: 2.2, amp: .35, noise: .2, phase: 15 }), MLSS: sim({ base: 3200, amp: .05, noise: .04 }), 'eff:BOD': sim({ base: 14, amp: .3, noise: .12, phase: 6 }), 'eff:COD': sim({ base: 55, amp: .25, noise: .12, phase: 6 }), 'eff:TSS': sim({ base: 18, amp: .3, noise: .15, phase: 7 }), PH: sim({ base: 7.3, amp: .02, noise: .01 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .2, noise: .05, phase: 10, scale: 'plantKw' }), 'in:COD': sim({ base: 320, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 3, amp: .3, noise: .2, phase: 8 }), ORP: sim({ base: 120, amp: .3, noise: .1, phase: 15 }) } },
  OD: { code: 'OD', name: PLANT_TYPE.OD, kind: 'community', stages: ['inlet', 'screen', 'ditch', 'clarifier', 'disinfect', 'outlet', 'sludge'],
    monitor: [...COMMON_IN, M('ditch', 'DO', { required: true, target: [0.5, 2], note: 'โซนแอโรบิก/แอนอกซิกในคลองเดียวกัน วัด 2 จุด' }), M('ditch', 'ORP', { required: true }), M('ditch', 'MLSS', { target: [3000, 5000] }), ...COMMON_OUT],
    energy: { kwh_m3: [0.4, 0.8], ...EST('ช่วงอ้างอิง OD 0.4–0.8 kWh/m³ (เติมอากาศต่อเนื่อง)') },
    sim: { DO: sim({ base: 1.2, amp: .5, noise: .25, phase: 15 }), ORP: sim({ base: 20, amp: 2, noise: .5, phase: 12 }), MLSS: sim({ base: 3800, amp: .05, noise: .04 }), 'eff:BOD': sim({ base: 10, amp: .3, noise: .12 }), 'eff:COD': sim({ base: 45, amp: .25, noise: .1 }), 'eff:TSS': sim({ base: 15, amp: .3, noise: .15 }), PH: sim({ base: 7.4, amp: .02, noise: .01 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .1, noise: .05, scale: 'plantKw' }), 'in:COD': sim({ base: 300, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 2, amp: .3, noise: .2 }) } },
  SBR: { code: 'SBR', name: PLANT_TYPE.SBR, kind: 'community', stages: ['inlet', 'screen', 'eq', 'sbr', 'disinfect', 'outlet', 'sludge'],
    monitor: [...COMMON_IN, M('eq', 'Level', { required: true, note: 'ควบคุมรอบเติม/ระบาย' }), M('sbr', 'DO', { required: true, target: [1, 3] }), M('sbr', 'ORP', { required: true, note: 'จบขั้นตอนตามค่า ORP ประหยัดเวลาเติมอากาศ' }), M('sbr', 'MLSS'), M('sbr', 'Level', { required: true }), ...COMMON_OUT],
    energy: { kwh_m3: [0.4, 0.7], ...EST('ช่วงอ้างอิง SBR 0.4–0.7 kWh/m³') },
    sim: { DO: sim({ base: 1.8, amp: .6, noise: .3, phase: 14 }), ORP: sim({ base: 60, amp: 1.5, noise: .4, phase: 14 }), MLSS: sim({ base: 3500, amp: .08, noise: .05 }), Level: sim({ base: 3.5, amp: .3, noise: .02, phase: 16 }), 'eff:BOD': sim({ base: 12, amp: .3, noise: .12 }), 'eff:COD': sim({ base: 50, amp: .25, noise: .1 }), 'eff:TSS': sim({ base: 16, amp: .3, noise: .15 }), PH: sim({ base: 7.2, amp: .02, noise: .01 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .3, noise: .08, scale: 'plantKw' }), 'in:COD': sim({ base: 330, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 2.5, amp: .3, noise: .2 }) } },
  AL: { code: 'AL', name: PLANT_TYPE.AL, kind: 'community', stages: ['inlet', 'screen', 'lagoon', 'pond2', 'outlet'],
    monitor: [...COMMON_IN, M('lagoon', 'DO', { required: true, target: [1, 3], note: 'ควบคุมเครื่องเติมอากาศผิวน้ำ' }), M('lagoon', 'Temp'), M('pond2', 'DO'), ...COMMON_OUT],
    energy: { kwh_m3: [0.2, 0.5], ...EST('ช่วงอ้างอิง AL 0.2–0.5 kWh/m³') },
    sim: { DO: sim({ base: 2, amp: .5, noise: .25, phase: 15 }), Temp: sim({ base: 29, amp: .06, noise: .02, phase: 15 }), 'eff:BOD': sim({ base: 18, amp: .3, noise: .12 }), 'eff:COD': sim({ base: 70, amp: .25, noise: .1 }), 'eff:TSS': sim({ base: 28, amp: .3, noise: .15 }), PH: sim({ base: 7.6, amp: .03, noise: .01 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .15, noise: .05, scale: 'plantKw' }), 'in:COD': sim({ base: 280, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 5, amp: .3, noise: .2 }) } },
  SP: { code: 'SP', name: PLANT_TYPE.SP, kind: 'community', stages: ['inlet', 'screen', 'pond1', 'pond2', 'outlet'],
    monitor: [M('inlet', 'Flow', { required: true }), M('inlet', 'PH'), M('pond1', 'DO', { note: 'บ่อแฟคัลเททีฟ DO ต่ำตอนเช้าเป็นปกติ' }), M('pond2', 'DO', { required: true }), M('pond2', 'PH', { note: 'สาหร่ายทำ pH สูงตอนบ่าย' }), M('pond2', 'Temp'), M('outlet', 'Flow', { required: true }), M('outlet', 'eff:BOD', { required: true }), M('outlet', 'eff:TSS', { required: true }), M('outlet', 'PH'), M('plant', 'Watt')],
    energy: { kwh_m3: [0.02, 0.1], ...EST('ช่วงอ้างอิง SP 0.02–0.1 kWh/m³ (ปั๊มเป็นหลัก)') },
    sim: { DO: sim({ base: 4, amp: .8, noise: .3, phase: 15 }), PH: sim({ base: 8, amp: .06, noise: .02, phase: 15 }), Temp: sim({ base: 30, amp: .06, noise: .02, phase: 15 }), 'eff:BOD': sim({ base: 22, amp: .3, noise: .15 }), 'eff:TSS': sim({ base: 40, amp: .3, noise: .2 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .2, noise: .05, scale: 'plantKw' }) } },
  CW: { code: 'CW', name: PLANT_TYPE.CW, kind: 'community', stages: ['inlet', 'screen', 'primary', 'wetland', 'outlet'],
    monitor: [M('inlet', 'Flow', { required: true }), M('inlet', 'PH'), M('inlet', 'in:TSS', { note: 'ตะกอนมากทำให้บึงอุดตัน' }), M('wetland', 'Level', { required: true, note: 'ระดับน้ำใต้ผิวชั้นกรวด' }), M('wetland', 'DO'), M('outlet', 'Flow', { required: true }), M('outlet', 'eff:BOD', { required: true }), M('outlet', 'eff:TSS', { required: true }), M('outlet', 'NH4N'), M('outlet', 'PH'), M('plant', 'Watt')],
    energy: { kwh_m3: [0.01, 0.05], ...EST('ช่วงอ้างอิง CW 0.01–0.05 kWh/m³ (ไหลตามแรงโน้มถ่วง/ปั๊มเล็ก)') },
    sim: { Level: sim({ base: .5, amp: .05, noise: .02 }), DO: sim({ base: 1.5, amp: .4, noise: .2, phase: 15 }), 'eff:BOD': sim({ base: 15, amp: .2, noise: .1 }), 'eff:TSS': sim({ base: 20, amp: .2, noise: .15 }), NH4N: sim({ base: 4, amp: .2, noise: .15 }), PH: sim({ base: 7.1, amp: .02, noise: .01 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .1, noise: .05, scale: 'plantKw' }), 'in:TSS': sim({ base: 180, amp: .3, noise: .15, phase: 9 }) } },
  RBC: { code: 'RBC', name: PLANT_TYPE.RBC, kind: 'community', stages: ['inlet', 'screen', 'primary', 'rbc', 'clarifier', 'disinfect', 'outlet', 'sludge'],
    monitor: [...COMMON_IN, M('rbc', 'DO', { required: true, target: [1, 3] }), M('rbc', 'PH'), M('clarifier', 'Level'), ...COMMON_OUT],
    energy: { kwh_m3: [0.15, 0.4], ...EST('ช่วงอ้างอิง RBC 0.15–0.4 kWh/m³ (มอเตอร์หมุนจาน)') },
    sim: { DO: sim({ base: 2.5, amp: .3, noise: .2, phase: 15 }), PH: sim({ base: 7.3, amp: .02, noise: .01 }), 'eff:BOD': sim({ base: 16, amp: .3, noise: .12 }), 'eff:COD': sim({ base: 60, amp: .25, noise: .1 }), 'eff:TSS': sim({ base: 20, amp: .3, noise: .15 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .05, noise: .03, scale: 'plantKw' }), 'in:COD': sim({ base: 300, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 3, amp: .3, noise: .2 }) } },
  MBR: { code: 'MBR', name: PLANT_TYPE.MBR, kind: 'community', stages: ['inlet', 'screen', 'anoxic', 'aeration', 'membrane', 'outlet', 'sludge'],
    monitor: [...COMMON_IN, M('anoxic', 'ORP', { required: true }), M('aeration', 'DO', { required: true, target: [1, 2.5] }), M('aeration', 'MLSS', { required: true, target: [8000, 12000] }), M('membrane', 'Level', { required: true, note: 'TMP/ระดับน้ำเหนือเมมเบรน (ตัน)' }), M('membrane', 'Tur', { required: true, note: 'ความขุ่นน้ำซึม < 1 NTU เตือนเมมเบรนรั่ว' }), ...COMMON_OUT],
    energy: { kwh_m3: [0.8, 1.5], ...EST('ช่วงอ้างอิง MBR 0.8–1.5 kWh/m³ (เติมอากาศล้างเมมเบรน)') },
    sim: { DO: sim({ base: 1.8, amp: .3, noise: .2, phase: 15 }), ORP: sim({ base: -20, amp: 2, noise: .5 }), MLSS: sim({ base: 9500, amp: .04, noise: .03 }), Level: sim({ base: 4, amp: .05, noise: .02 }), Tur: sim({ base: .4, amp: .3, noise: .3 }), 'eff:BOD': sim({ base: 4, amp: .3, noise: .2 }), 'eff:COD': sim({ base: 25, amp: .25, noise: .15 }), 'eff:TSS': sim({ base: 2, amp: .3, noise: .3 }), PH: sim({ base: 7.2, amp: .02, noise: .01 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .15, noise: .05, scale: 'plantKw' }), 'in:COD': sim({ base: 350, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 1, amp: .3, noise: .2 }) } },
  UASB: { code: 'UASB', name: PLANT_TYPE.UASB, kind: 'community', stages: ['inlet', 'screen', 'eq', 'anaerobic', 'lagoon', 'outlet', 'sludge'],
    monitor: [...COMMON_IN, M('eq', 'Level', { required: true }), M('anaerobic', 'PH', { required: true, target: [6.8, 7.4], note: 'pH ตกแสดงว่ากรดสะสม' }), M('anaerobic', 'Temp', { required: true }), M('anaerobic', 'ORP'), M('anaerobic', 'Level', { note: 'ระดับชั้นตะกอน (sludge bed)' }), M('lagoon', 'DO', { note: 'ขั้นตอนหลังบำบัด' }), ...COMMON_OUT],
    energy: { kwh_m3: [0.05, 0.15], ...EST('ช่วงอ้างอิง UASB 0.05–0.15 kWh/m³ (ผลิตก๊าซชีวภาพชดเชยได้)') },
    sim: { PH: sim({ base: 7, amp: .02, noise: .01 }), Temp: sim({ base: 31, amp: .04, noise: .02 }), ORP: sim({ base: -280, amp: .05, noise: .05 }), Level: sim({ base: 2.5, amp: .03, noise: .02 }), DO: sim({ base: 1.5, amp: .4, noise: .2, phase: 15 }), 'eff:BOD': sim({ base: 25, amp: .25, noise: .12 }), 'eff:COD': sim({ base: 90, amp: .25, noise: .12 }), 'eff:TSS': sim({ base: 30, amp: .3, noise: .15 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .1, noise: .05, scale: 'plantKw' }), 'in:COD': sim({ base: 600, amp: .3, noise: .15, phase: 9 }), NH4N: sim({ base: 8, amp: .2, noise: .15 }) } },
  Anaerobic: { code: 'Anaerobic', name: PLANT_TYPE.Anaerobic, kind: 'community', stages: ['inlet', 'screen', 'anaerobic', 'pond2', 'outlet', 'sludge'],
    monitor: [M('inlet', 'Flow', { required: true }), M('inlet', 'PH', { required: true }), M('inlet', 'in:COD'), M('anaerobic', 'PH', { required: true, target: [6.8, 7.4] }), M('anaerobic', 'Temp', { required: true }), M('anaerobic', 'ORP'), M('pond2', 'DO'), M('outlet', 'Flow', { required: true }), M('outlet', 'PH', { required: true }), M('outlet', 'eff:BOD', { required: true }), M('outlet', 'eff:COD'), M('outlet', 'eff:TSS', { required: true }), M('plant', 'Watt')],
    energy: { kwh_m3: [0.03, 0.12], ...EST('ช่วงอ้างอิงระบบไร้อากาศ 0.03–0.12 kWh/m³') },
    sim: { PH: sim({ base: 7, amp: .02, noise: .01 }), Temp: sim({ base: 31, amp: .04, noise: .02 }), ORP: sim({ base: -250, amp: .05, noise: .05 }), DO: sim({ base: 1.2, amp: .4, noise: .2, phase: 15 }), 'eff:BOD': sim({ base: 30, amp: .25, noise: .12 }), 'eff:COD': sim({ base: 110, amp: .25, noise: .12 }), 'eff:TSS': sim({ base: 35, amp: .3, noise: .15 }), Flow: sim({ base: 1, amp: .35, noise: .08, phase: 10, scale: 'capacity' }), Watt: sim({ base: 1, amp: .1, noise: .05, scale: 'plantKw' }), 'in:COD': sim({ base: 500, amp: .3, noise: .15, phase: 9 }) } },
  IND: { code: 'IND', name: 'Industrial WWTP · น้ำทิ้งโรงงานอุตสาหกรรม (POMS/WPMS)', kind: 'industrial', stages: ['inlet', 'eq', 'primary', 'aeration', 'clarifier', 'outlet', 'sludge'],
    diw_rule: 'ประกาศกรมโรงงานฯ: โรงงานที่ระบายน้ำทิ้ง ≥ 500 m³/วัน หรือมีภาระ BOD เข้า ≥ 4,000 kg/วัน ต้องติดตั้งเครื่องวัด COD/BOD ออนไลน์ (พร้อม Flow, pH) และส่งข้อมูลต่อเนื่องเข้าระบบ POMS/WPMS ของกรมโรงงานฯ',
    monitor: [M('inlet', 'Flow', { required: true }), M('inlet', 'PH', { required: true, note: 'น้ำเสียอุตสาหกรรมแกว่งแรง' }), M('inlet', 'in:COD', { required: true }), M('eq', 'Level', { required: true }), M('eq', 'PH', { note: 'ปรับกรด-ด่างก่อนชีวภาพ' }), M('aeration', 'DO', { required: true, target: [1.5, 3] }), M('aeration', 'MLSS'), M('outlet', 'Flow', { required: true, note: 'ข้อกำหนด POMS' }), M('outlet', 'PH', { required: true, note: 'ข้อกำหนด POMS' }), M('outlet', 'eff:COD', { required: true, note: 'ข้อกำหนด POMS: COD ออนไลน์ (UV-VIS/เครื่องวิเคราะห์)' }), M('outlet', 'eff:BOD', { required: true, note: 'ข้อกำหนด POMS: BOD ออนไลน์/สหสัมพันธ์' }), M('outlet', 'eff:TSS'), M('plant', 'Watt', { required: true, note: 'POMS ส่ง Watt ของระบบบำบัด' })],
    energy: { kwh_m3: [0.5, 2.0], ...EST('น้ำทิ้งอุตสาหกรรมต่างกันมากตามชนิด 0.5–2.0 kWh/m³ (ค่าประมาณ) — เทียบค่าวัดจริงจาก POMS Watt/Flow') },
    sim: { DO: sim({ base: 2, amp: .3, noise: .2, phase: 15 }), MLSS: sim({ base: 3500, amp: .05, noise: .04 }), Level: sim({ base: 3, amp: .2, noise: .05, phase: 12 }), 'eff:COD': sim({ base: 80, amp: .35, noise: .2, phase: 11 }), 'eff:BOD': sim({ base: 12, amp: .35, noise: .2, phase: 11 }), 'eff:TSS': sim({ base: 25, amp: .3, noise: .2 }), PH: sim({ base: 7.5, amp: .04, noise: .02 }), Flow: sim({ base: 1, amp: .45, noise: .1, phase: 12, scale: 'capacity' }), Watt: sim({ base: 1, amp: .3, noise: .08, phase: 12, scale: 'plantKw' }), 'in:COD': sim({ base: 900, amp: .4, noise: .25, phase: 11 }) } },
};
export const PROCESS_CODES = Object.keys(PROCESS_TYPES);

/** ชนิดเซนเซอร์/อุปกรณ์ (พลังงาน ราคา = ค่าประมาณ) */
export const SENSOR_TYPES = {
  DO: { name: 'หัววัดออกซิเจนละลาย (DO)', tech: 'Optical luminescent (LDO) — ไม่ใช้เมมเบรน/อิเล็กโทรไลต์', params: ['DO'], unit: 'mg/L', power_w: [1, 3], comms: ['4–20 mA', 'Modbus RTU', 'SDI-12'], stds: ['ISO 17289 (LDO)', 'MCERTS', 'IP68', 'CE'], price_thb: [45000, 120000], maint: 'ล้างเดือนละครั้ง เปลี่ยนแคปทุก 1–2 ปี', select: ['เลือกแบบ optical (บำรุงรักษาต่ำกว่า galvanic)', 'มีตัวปัดทำความสะอาดอัตโนมัติถ้าติดในถังเติมอากาศ', 'ชดเชยอุณหภูมิ/ความดันในตัว'], ...EST('ราคาตลาด 2568 ช่วงกว้าง ขึ้นกับตัวควบคุม') },
  PH: { name: 'หัววัด pH', tech: 'แก้ว/ดิฟเฟอเรนเชียล (differential pH) ทนน้ำเสีย', params: ['PH'], unit: '', power_w: [0.5, 2], comms: ['4–20 mA', 'Modbus RTU', 'Memosens/digital'], stds: ['ISO 10523', 'US EPA 150.1', 'IP68', 'CE'], price_thb: [15000, 60000], maint: 'สอบเทียบเดือนละครั้ง เปลี่ยนหัวปีละครั้ง', select: ['แบบ differential ทนการอุดตันในน้ำเสีย', 'มีการชดเชยอุณหภูมิ'], ...EST('ราคาตลาด 2568') },
  ORP: { name: 'หัววัด ORP', tech: 'อิเล็กโทรดแพลทินัม', params: ['ORP'], unit: 'mV', power_w: [0.5, 2], comms: ['4–20 mA', 'Modbus RTU'], stds: ['ASTM D1498', 'IP68', 'CE'], price_thb: [15000, 50000], maint: 'สอบเทียบเดือนละครั้ง', select: ['ใช้ควบคุมเปิด/ปิดเครื่องเติมอากาศในถังแอนอกซิก/SBR'], ...EST('ราคาตลาด 2568') },
  MLSS: { name: 'หัววัด MLSS/TSS ในถัง', tech: 'Nephelometric/IR light scattering หลายมุม', params: ['MLSS', 'in:TSS'], unit: 'mg/L', power_w: [1, 4], comms: ['4–20 mA', 'Modbus RTU'], stds: ['ISO 7027 (nephelometry)', 'MCERTS', 'IP68'], price_thb: [60000, 150000], maint: 'ตัวปัด/ล้างอากาศอัตโนมัติ สอบเทียบกับแล็บรายเดือน', select: ['ช่วงวัดถึง 10,000–30,000 mg/L สำหรับ MBR', 'มีระบบทำความสะอาดอัตโนมัติ'], ...EST('ราคาตลาด 2568') },
  TSS: { name: 'หัววัดสารแขวนลอยน้ำทิ้ง (TSS/ความขุ่น)', tech: 'Nephelometric 90° (ISO 7027)', params: ['eff:TSS', 'Tur'], unit: 'mg/L · NTU', power_w: [1, 3], comms: ['4–20 mA', 'Modbus RTU'], stds: ['ISO 7027', 'US EPA 180.1', 'MCERTS', 'IP68'], price_thb: [50000, 130000], maint: 'ล้างรายสัปดาห์ สอบเทียบรายเดือน', select: ['ช่วงต่ำ 0–1,000 mg/L สำหรับน้ำทิ้ง', 'สหสัมพันธ์ NTU→mg/L ต้องทำกับแล็บของโรง'], ...EST('ราคาตลาด 2568') },
  NH4N: { name: 'หัววัดแอมโมเนียม (NH4-N)', tech: 'Ion-selective electrode (ISE) พร้อมชดเชย K+ หรือเครื่องวิเคราะห์ colorimetric', params: ['NH4N'], unit: 'mg/L', power_w: [2, 15], comms: ['4–20 mA', 'Modbus RTU'], stds: ['ISO 15839 (online sensors)', 'MCERTS', 'IP68'], price_thb: [90000, 350000], maint: 'เปลี่ยนอิเล็กโทรด 6–12 เดือน สอบเทียบ 2 สัปดาห์', select: ['ISE ราคาต่ำ/ต้องสอบเทียบบ่อย', 'analyzer แม่นแต่ใช้รีเอเจนต์'], ...EST('ราคาตลาด 2568') },
  COD: { name: 'เครื่องวัด COD ออนไลน์', tech: 'UV254/UV-VIS spectrometry (สหสัมพันธ์กับ COD) หรือ analyzer แบบ dichromate/ozone', params: ['eff:COD', 'in:COD'], unit: 'mg/L', power_w: [5, 60], comms: ['4–20 mA', 'Modbus RTU/TCP', 'Ethernet'], stds: ['ISO 15839', 'US EPA 410.4 (เทียบเท่า)', 'MCERTS', 'ข้อกำหนด POMS กรมโรงงานฯ'], price_thb: [250000, 900000], maint: 'ล้างอัตโนมัติ สอบเทียบกับแล็บรายเดือน · analyzer ใช้รีเอเจนต์/ของเสียอันตราย', select: ['UV-VIS ไม่ใช้สารเคมี เหมาะโรงบำบัดชุมชน', 'analyzer แบบ dichromate ตรงวิธีมาตรฐาน เหมาะน้ำทิ้งโรงงานที่ POMS กำหนด', 'ต้องมีระบบดึงตัวอย่าง/กรอง'], ...EST('ราคาตลาด 2568 (UV-VIS ต่ำสุด, analyzer สูงสุด)') },
  BOD: { name: 'เครื่องวัด BOD ออนไลน์', tech: 'UV-VIS สหสัมพันธ์ (BOD equivalent) หรือ respirometric/biosensor', params: ['eff:BOD', 'in:BOD'], unit: 'mg/L', power_w: [5, 80], comms: ['4–20 mA', 'Modbus RTU/TCP'], stds: ['ISO 15839', 'ข้อกำหนด POMS กรมโรงงานฯ', 'MCERTS'], price_thb: [300000, 1200000], maint: 'สอบเทียบกับ BOD5 แล็บรายเดือน', select: ['UV-VIS วัด COD และ BOD-equivalent ในเครื่องเดียว ประหยัดกว่า', 'respirometric ให้ค่าใกล้ BOD5 แต่ช้า (ชั่วโมง)'], ...EST('ราคาตลาด 2568') },
  Flow_us: { name: 'มาตรวัดอัตราไหลรางเปิด', tech: 'Ultrasonic level + ฝายวัด/รางพาร์แชล (open channel)', params: ['Flow'], unit: 'm³/hr', power_w: [1, 3], comms: ['4–20 mA', 'Modbus RTU', 'pulse'], stds: ['ISO 6416 / ISO 4359 (ฝาย/ราง)', 'IP68'], price_thb: [40000, 120000], maint: 'ตรวจตะกอนหน้าฝายรายเดือน', select: ['เหมาะน้ำเข้า/น้ำออกที่ไหลตามแรงโน้มถ่วง', 'ต้องมีโครงสร้างวัดตามมาตรฐาน'], ...EST('ราคาตลาด 2568 ไม่รวมงานโยธา') },
  Flow_em: { name: 'มาตรวัดอัตราไหลแม่เหล็กไฟฟ้า', tech: 'Electromagnetic (magflow) ในท่อเต็ม', params: ['Flow'], unit: 'm³/hr', power_w: [5, 15], comms: ['4–20 mA', 'Modbus RTU', 'pulse', 'HART'], stds: ['ISO 6817 / OIML R49', 'IP68 (แบบฝัง)', 'MCERTS'], price_thb: [40000, 200000], maint: 'ตรวจอิเล็กโทรดปีละครั้ง', select: ['ต้องมีท่อตรง 5D/3D', 'ใช้กับท่อสูบ/ท่อจ่าย'], ...EST('ราคาตลาด 2568 ตามขนาดท่อ') },
  Level: { name: 'เซนเซอร์ระดับน้ำ', tech: 'Ultrasonic/radar/hydrostatic', params: ['Level'], unit: 'm', power_w: [0.5, 3], comms: ['4–20 mA', 'Modbus RTU'], stds: ['IP68', 'ATEX/IECEx (ถ้าบ่อมีก๊าซ)'], price_thb: [10000, 50000], maint: 'ตรวจโฟม/ตะกอนเกาะ', select: ['radar ไม่ไวต่อโฟม/ไอน้ำ', 'hydrostatic ราคาถูกแต่ต้องล้าง'], ...EST('ราคาตลาด 2568') },
  Temp: { name: 'หัววัดอุณหภูมิน้ำ', tech: 'Pt100/Pt1000 (มักรวมในหัว DO/pH)', params: ['Temp'], unit: '°C', power_w: [0.2, 1], comms: ['4–20 mA', 'Modbus RTU'], stds: ['IEC 60751', 'IP68'], price_thb: [5000, 20000], maint: 'แทบไม่ต้อง', select: ['ใช้ค่าจากหัว DO/pH ได้ถ้ามี'], ...EST('ราคาตลาด 2568') },
  Watt: { name: 'มิเตอร์ไฟฟ้า/เพาเวอร์มิเตอร์', tech: 'Digital power meter + CT (3 เฟส)', params: ['Watt'], unit: 'kW · kWh', power_w: [2, 5], comms: ['Modbus RTU', 'Modbus TCP', 'pulse'], stds: ['IEC 62053-21/22 class 1/0.5S', 'CE'], price_thb: [8000, 40000], maint: 'ไม่ต้อง', select: ['แยกวงจรวัด: เครื่องเติมอากาศ / ปั๊ม / เซนเซอร์-ควบคุม', 'ใช้คิด kWh/m³ จริง'], ...EST('ราคาตลาด 2568') },
  Logger: { name: 'ดาต้าล็อกเกอร์/RTU', tech: 'RTU/PLC เก็บค่า สุ่มทุก 1–15 นาที เก็บสำรองในเครื่อง', params: [], unit: '', power_w: [3, 10], comms: ['Modbus RTU/TCP (เข้า)', 'MQTT/HTTP (ออก)'], stds: ['IEC 61131 (PLC)', 'IP65 ตู้', 'CE'], price_thb: [20000, 90000], maint: 'อัปเดตเฟิร์มแวร์', select: ['ต้องมี buffer เก็บข้อมูลเมื่อเน็ตล่ม ≥ 7 วัน', 'time sync (NTP/GPS)'], ...EST('ราคาตลาด 2568') },
  Gateway: { name: 'เกตเวย์สื่อสาร', tech: '4G/LTE router หรือ LoRaWAN gateway / NB-IoT', params: [], unit: '', power_w: [3, 12], comms: ['4G', 'LoRaWAN', 'NB-IoT', 'Ethernet'], stds: ['กสทช. (NBTC) type approval', 'IP65/67', 'CE'], price_thb: [8000, 40000], maint: 'ค่าซิม/แพ็กเกจรายเดือน', select: ['4G เมื่อมีสัญญาณและต้องส่งข้อมูลถี่', 'LoRaWAN เมื่อจุดวัดกระจายไกล พลังงานต่ำ', 'NB-IoT จุดวัดเดี่ยวส่งนาน ๆ ครั้ง'], ...EST('ราคาตลาด 2568') },
  Controller: { name: 'ตัวควบคุม/ทรานสมิตเตอร์หลายช่อง', tech: 'Multi-parameter controller (ต่อหัววัดดิจิทัล 2–8 หัว) + จอแสดงผล', params: [], unit: '', power_w: [5, 15], comms: ['Modbus RTU/TCP', 'Profibus', '4–20 mA out'], stds: ['IP66', 'CE', 'UL'], price_thb: [40000, 150000], maint: 'ไม่ต้อง', select: ['ลดจำนวนทรานสมิตเตอร์ ใช้หัวดิจิทัลร่วมกัน'], ...EST('ราคาตลาด 2568') },
};
/** พารามิเตอร์ → ชนิดเซนเซอร์ (ตามตำแหน่ง) */
export function sensorFor(param, stage) {
  if (param === 'Flow') return stage === 'inlet' || stage === 'outlet' ? 'Flow_us' : 'Flow_em';
  if (param === 'in:TSS') return 'MLSS';
  if (param === 'Tur') return 'TSS';
  const base = param.replace(/^(eff|in):/, '');
  return SENSOR_TYPES[base] ? base : null;
}

/** ตัวอย่างแบรนด์/รุ่น (ข้อมูลสาธารณะจากผู้ผลิต ณ ก.ย. 2569 — ไม่ใช่การรับรอง ต้องตรวจเอกสารรับรองรุ่นจริงกับผู้จำหน่าย) */
export const BRAND_EXAMPLES = [
  { sensor: 'DO', brand: 'Hach', model: 'LDO2 / LDO sc', certs: ['MCERTS', 'IP68'], note: 'optical LDO' },
  { sensor: 'DO', brand: 'Endress+Hauser', model: 'Oxymax COS61D (Memosens)', certs: ['IP68', 'ATEX (บางรุ่น)'], note: 'optical, digital Memosens' },
  { sensor: 'DO', brand: 'Xylem / YSI (WTW)', model: 'FDO 700 IQ / IQ SensorNet', certs: ['IP68'], note: 'optical' },
  { sensor: 'DO', brand: 'Horiba', model: 'HD-480 / OD-… series', certs: ['CE'], note: 'ใช้แพร่หลายในไทย' },
  { sensor: 'PH', brand: 'Hach', model: 'pHD sc (differential)', certs: ['MCERTS', 'IP68'], note: 'differential pH ทนน้ำเสีย' },
  { sensor: 'PH', brand: 'Endress+Hauser', model: 'Orbisint CPS11D / Ceramax', certs: ['IP68', 'ATEX (บางรุ่น)'], note: 'Memosens' },
  { sensor: 'PH', brand: 'Yokogawa', model: 'FLXA402 + PH8ERP', certs: ['CE', 'ATEX (บางรุ่น)'], note: 'ทรานสมิตเตอร์ 4 ช่อง' },
  { sensor: 'ORP', brand: 'Endress+Hauser', model: 'Orbisint CPS12D', certs: ['IP68'], note: '' },
  { sensor: 'MLSS', brand: 'Hach', model: 'Solitax sc', certs: ['MCERTS', 'IP68'], note: 'TSS/MLSS ถึง 150 g/L' },
  { sensor: 'MLSS', brand: 'Endress+Hauser', model: 'Turbimax CUS51D', certs: ['IP68'], note: 'MLSS/TSS' },
  { sensor: 'TSS', brand: 'Xylem / WTW', model: 'VisoTurb 700 IQ', certs: ['IP68'], note: 'ความขุ่น/TSS' },
  { sensor: 'TSS', brand: 'Hach', model: 'TSS sc / Surface Scatter 7', certs: ['MCERTS'], note: '' },
  { sensor: 'NH4N', brand: 'Hach', model: 'AN-ISE sc / Amtax sc', certs: ['MCERTS', 'IP68'], note: 'ISE / analyzer' },
  { sensor: 'NH4N', brand: 'Endress+Hauser', model: 'ISEmax CAS40D / Liquiline System CA80AM', certs: ['IP68'], note: 'ISE / colorimetric' },
  { sensor: 'COD', brand: 'Hach', model: 'UVAS plus sc', certs: ['MCERTS'], note: 'UV254 (SAC) สหสัมพันธ์ COD' },
  { sensor: 'COD', brand: 's::can (Badger Meter)', model: 'spectro::lyser', certs: ['MCERTS'], note: 'UV-VIS COD/BOD/TSS/NO3 ในหัวเดียว' },
  { sensor: 'COD', brand: 'Endress+Hauser', model: 'Viomax CAS51D', certs: ['IP68'], note: 'UV SAC/COD' },
  { sensor: 'COD', brand: 'Hach', model: 'CODmax II', certs: ['CE'], note: 'analyzer dichromate ตามวิธีมาตรฐาน (ใช้รีเอเจนต์)' },
  { sensor: 'BOD', brand: 's::can (Badger Meter)', model: 'spectro::lyser (BOD-eq)', certs: ['MCERTS'], note: 'UV-VIS BOD-equivalent' },
  { sensor: 'BOD', brand: 'Hach', model: 'BODTrak II (แล็บ) / UVAS BOD-eq', certs: ['CE'], note: 'ใช้คู่กับสหสัมพันธ์แล็บ' },
  { sensor: 'Flow_em', brand: 'Siemens', model: 'SITRANS FM MAG 5100 W', certs: ['MCERTS', 'OIML R49', 'IP68'], note: 'น้ำเสีย/น้ำดิบ' },
  { sensor: 'Flow_em', brand: 'Endress+Hauser', model: 'Promag W 400', certs: ['MCERTS', 'IP68'], note: '' },
  { sensor: 'Flow_em', brand: 'ABB', model: 'ProcessMaster / WaterMaster', certs: ['MCERTS', 'OIML R49'], note: '' },
  { sensor: 'Flow_us', brand: 'Siemens', model: 'SITRANS LUT400 + Echomax', certs: ['MCERTS (open channel)', 'IP68'], note: 'รางเปิด' },
  { sensor: 'Flow_us', brand: 'Hach', model: 'FL900 / Flo-Dar', certs: ['MCERTS'], note: 'radar velocity ท่อไม่เต็ม' },
  { sensor: 'Level', brand: 'VEGA', model: 'VEGAPULS (radar)', certs: ['ATEX/IECEx', 'IP68'], note: 'radar 80 GHz' },
  { sensor: 'Level', brand: 'Endress+Hauser', model: 'Prosonic / Micropilot FMR', certs: ['ATEX', 'IP68'], note: '' },
  { sensor: 'Watt', brand: 'Schneider Electric', model: 'PowerLogic PM2000/PM5000', certs: ['IEC 62053-22 class 0.5S'], note: 'Modbus' },
  { sensor: 'Watt', brand: 'Mitsubishi Electric', model: 'ME96SS', certs: ['IEC 62053'], note: 'ใช้แพร่หลายในไทย' },
  { sensor: 'Logger', brand: 'Siemens', model: 'SIMATIC S7-1200 + IoT2050', certs: ['IEC 61131', 'CE'], note: 'PLC + MQTT' },
  { sensor: 'Logger', brand: 'Advantech', model: 'ADAM-3600 / WISE-4000', certs: ['CE', 'UL'], note: 'RTU/IoT' },
  { sensor: 'Gateway', brand: 'Teltonika', model: 'RUT241/RUT956', certs: ['NBTC', 'CE'], note: '4G router' },
  { sensor: 'Gateway', brand: 'Kerlink / Milesight', model: 'iStation / UG65', certs: ['NBTC', 'IP67'], note: 'LoRaWAN gateway' },
  { sensor: 'Controller', brand: 'Hach', model: 'SC4500', certs: ['CE', 'UL'], note: '2–8 หัววัดดิจิทัล' },
  { sensor: 'Controller', brand: 'Endress+Hauser', model: 'Liquiline CM44x', certs: ['CE', 'ATEX (บางรุ่น)'], note: 'Memosens 8 ช่อง' },
];
export const brandsFor = (sensor) => BRAND_EXAMPLES.filter((b) => b.sensor === sensor);

export const COMMS = {
  '4–20 mA': { name: 'สัญญาณอนาล็อก 4–20 mA', role: 'หัววัด → ตัวควบคุม/RTU', note: 'ทนสัญญาณรบกวน สายละ 1 ค่า' },
  'Modbus RTU': { name: 'Modbus RTU (RS-485)', role: 'หัววัด/มิเตอร์ → RTU', note: 'หลายอุปกรณ์บนสายเดียว ≤ 1.2 กม.' },
  'Modbus TCP': { name: 'Modbus TCP (Ethernet)', role: 'RTU/PLC ↔ SCADA', note: '' },
  MQTT: { name: 'MQTT ผ่าน 4G/อินเทอร์เน็ต', role: 'RTU → cloud', topic: 'envi/{site}/{stage}/{param}', qos: 1, note: 'เบา ทนเน็ตหลุด ใช้ TLS' },
  LoRaWAN: { name: 'LoRaWAN', role: 'โหนดไร้สาย → เกตเวย์', note: 'พลังงานต่ำ ส่งได้ 2–10 กม. ข้อมูลเล็ก ส่งทุก 5–15 นาที' },
  'NB-IoT': { name: 'NB-IoT', role: 'โหนด → เครือข่ายมือถือ', note: 'ซิมต่ออุปกรณ์ เหมาะจุดเดี่ยว' },
  '4G': { name: '4G/LTE', role: 'เกตเวย์ → อินเทอร์เน็ต', note: 'ส่งถี่ได้ ค่าใช้จ่ายรายเดือน' },
};

// ─────────────────────────────────────────────────────────── ออกแบบ (BOQ)
/** ออกแบบชุดเซนเซอร์ตามชนิดระบบและความสามารถ → รายการอุปกรณ์ (qty แก้ทีหลังได้) */
export function designSystem(code, capacityM3d = 5000, opts = {}) {
  const p = PROCESS_TYPES[code]; if (!p) throw new Error('ไม่รู้จักชนิดระบบ ' + code);
  const cap = Number(capacityM3d) || 0;
  const big = cap >= 20000, huge = cap >= 100000;
  const items = p.monitor.filter((m) => opts.requiredOnly ? m.required : true).map((m) => {
    const sensor = sensorFor(m.param, m.stage);
    let qty = 1;
    if ((m.param === 'DO' || m.param === 'ORP') && ['aeration', 'ditch', 'sbr', 'lagoon'].includes(m.stage)) qty = huge ? 4 : big ? 2 : 1;
    if (m.param === 'MLSS' && ['aeration', 'ditch'].includes(m.stage) && huge) qty = 2;
    return { stage: m.stage, param: m.param, sensor, qty, required: m.required, note: m.note ?? '', target: m.target ?? null };
  });
  const sensorsCount = items.filter((i) => i.sensor && !['Watt'].includes(i.sensor)).reduce((a, i) => a + i.qty, 0);
  items.push({ stage: 'plant', param: null, sensor: 'Controller', qty: Math.max(1, Math.ceil(sensorsCount / 6)), required: true, note: 'ต่อหัววัดดิจิทัล ~6 หัว/เครื่อง' });
  items.push({ stage: 'plant', param: null, sensor: 'Logger', qty: 1, required: true, note: 'เก็บ/ส่งข้อมูลทุก 15 นาที · buffer 7 วัน' });
  items.push({ stage: 'plant', param: null, sensor: 'Gateway', qty: 1, required: true, note: opts.comms ?? '4G (ค่าเริ่มต้น)' });
  return { code, name: p.name, kind: p.kind, capacity: cap, stages: p.stages, diw_rule: p.kind === 'industrial' || cap >= 500 && code === 'IND' ? p.diw_rule : null, items, catalog_version: CATALOG_VERSION };
}
export const stageName = (s) => STAGES[s]?.name ?? s;

// ─────────────────────────────────────────────────────────── พลังงาน
/** งบพลังงานของระบบเซนเซอร์ (W avg/peak, kWh/วัน/ปี) — duty: สัดส่วนเวลาทำงาน (Logger/Gateway/analyzer 1.0, โหนด LoRa 0.1) */
export function powerBudget(design, { dutyDefault = 1, dutyBySensor = {} } = {}) {
  const items = design.items.filter((i) => i.sensor).map((i) => {
    const t = SENSOR_TYPES[i.sensor]; const duty = dutyBySensor[i.sensor] ?? dutyDefault;
    const wPeak = t.power_w[1] * i.qty, wAvg = ((t.power_w[0] + t.power_w[1]) / 2) * i.qty * duty;
    return { ...i, name: t.name, w_each: t.power_w, duty, w_peak: wPeak, w_avg: wAvg, price_lo: t.price_thb[0] * i.qty, price_hi: t.price_thb[1] * i.qty };
  });
  const w_peak = items.reduce((a, i) => a + i.w_peak, 0), w_avg = items.reduce((a, i) => a + i.w_avg, 0);
  return { items, w_peak, w_avg, kwh_day: w_avg * 24 / 1000, kwh_year: w_avg * 24 * 365 / 1000, price_lo: items.reduce((a, i) => a + i.price_lo, 0), price_hi: items.reduce((a, i) => a + i.price_hi, 0), ...EST('รวม W เฉลี่ย × 24 ชม. · ราคาช่วงตลาด 2568') };
}
/** ไฟฟ้าของโรงบำบัดตาม benchmark (kWh/m³) × ปริมาณน้ำ — คืนทั้งตามความสามารถออกแบบและน้ำเข้าจริง */
export function plantEnergy(code, { capacity = 0, avg_inflow = null, kwh_m3 = null } = {}) {
  const p = PROCESS_TYPES[code]; if (!p) throw new Error('ไม่รู้จักชนิดระบบ ' + code);
  const [lo, hi] = kwh_m3 ? [kwh_m3, kwh_m3] : p.energy.kwh_m3; const mid = (lo + hi) / 2;
  const calc = (q) => q ? { q, lo: lo * q, mid: mid * q, hi: hi * q, kwh_year_mid: mid * q * 365, kw_avg: mid * q / 24 } : null;
  return { code, kwh_m3: { lo, mid, hi }, design: calc(capacity), actual: calc(avg_inflow), ...EST(p.energy.source) };
}
/** kWh/m³ วัดจริงจาก POMS (kW เฉลี่ย ÷ Flow เฉลี่ย) — guard Flow 0 */
export function measuredIntensity(kwAvg, flowM3hAvg) {
  if (kwAvg == null || flowM3hAvg == null || flowM3hAvg <= 0) return null;
  return { kwh_m3: kwAvg / flowM3hAvg, kwh_day: kwAvg * 24, source: 'วัดจริง POMS (Watt ÷ Flow)', estimate: false };
}
/** อุณหภูมิแผง King/Sandia (สำเนาสูตรจาก envi-core.moduleTemp เพื่อให้โมดูลนี้ทดสอบเดี่ยวได้) */
export function moduleTempKS({ instantGhi = 800, windSpeed = 1.5, airTemp = 30 }, { a = -3.47, b = -0.0594, deltaT = 3 } = {}) {
  const back = instantGhi * Math.exp(a + b * windSpeed) + airTemp; return back + (instantGhi / 1000) * deltaT;
}
/**
 * ขนาดโซลาร์เซลล์ที่ต้องใช้ (ค่าประมาณ)
 *   kWp = kWh/วัน ÷ (PSH × PR) · PR = pr0 × (1 − tempCoef × max(0, Tmod − 25)) · พื้นที่ ≈ kWp × m²/kWp · ต้นทุน · payback อย่างง่าย
 */
export function solarSizing({ kwh_day, psh = 4.8, airTemp = 30, windSpeed = 1.5, pr0 = 0.80, tempCoef = 0.004, area_per_kwp = 6.5, cost_per_kwp = 35000, tariff = 4.2, sizing_margin = 1.1 } = {}) {
  if (!kwh_day || !psh) return null;
  const tmod = moduleTempKS({ instantGhi: 800, windSpeed, airTemp });
  const pr = Math.max(0.5, pr0 * (1 - tempCoef * Math.max(0, tmod - 25)));
  const kwp = kwh_day * sizing_margin / (psh * pr);
  const kwh_year = kwp * psh * pr * 365, cost = kwp * cost_per_kwp, saving = Math.min(kwh_year, kwh_day * 365) * tariff;
  return { kwh_day, psh, tmod, pr, kwp, area_m2: kwp * area_per_kwp, cost_thb: cost, kwh_year, saving_thb_year: saving, payback_years: saving > 0 ? cost / saving : null, sizing_margin, ...EST(`PSH จากข้อมูลรังสี × PR ${pr.toFixed(2)} (derating อุณหภูมิแผง ${tmod.toFixed(0)} °C) · ต้นทุน ${cost_per_kwp.toLocaleString()} บาท/kWp · ค่าไฟ ${tariff} บาท/kWh — ค่าประมาณ`) };
}
/** แบตเตอรี่สำรองระบบเซนเซอร์ (Wh) — ให้ทำงานกลางคืน/ฝนตกต่อเนื่อง */
export function batterySizing({ w_avg, night_hours = 12, autonomy_days = 2, dod = 0.8, system_v = 24 }) {
  if (!w_avg) return null;
  const wh = w_avg * night_hours * autonomy_days / dod;
  return { wh, ah: wh / system_v, system_v, autonomy_days, ...EST('W เฉลี่ย × ชม.กลางคืน × วันสำรอง ÷ DoD') };
}
/** PSH (kWh/m²/วัน) จาก meta ของสถานี dede_solar หรือค่า GHI รายปี */
export function pshFromDede(meta) {
  if (!meta) return null;
  if (meta.annual_kwh_m2) return meta.annual_kwh_m2 / 365;
  if (Array.isArray(meta.monthly) && meta.monthly.length === 12) return meta.monthly.reduce((a, b) => a + b, 0) / 12 / 3.6;
  if (meta.annual_avg_mj) return meta.annual_avg_mj / 3.6;
  return null;
}

// ─────────────────────────────────────────────────────────── จำลอง
/** PRNG mulberry32 — seed เดิมให้ผลเดิม (ใช้ในเทสต์และปุ่ม "ทำซ้ำ") */
export function rng(seed = 1) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
/**
 * อนุกรมเวลาจำลอง: v = base(1 + amp·sin(2π(h−phase)/24)) + noise·base·gauss · scale 'capacity' → base = capacity/24 (m³/hr) · 'plantKw' → kW เฉลี่ยของโรง
 *   event: {type:'spike'|'drop', at: ชั่วโมงเริ่ม, hours, factor}
 */
export function makeSeries(code, param, { hours = 168, seed = 42, start = Date.UTC(2026, 8, 1, 0, 0), stepMin = 60, capacity = 5000, plantKw = null, event = null } = {}) {
  const p = PROCESS_TYPES[code]; const s = p?.sim?.[param]; if (!s) return [];
  const r = rng(seed + hours + param.length);
  let base = s.base;
  if (s.scale === 'capacity') base = capacity / 24;
  if (s.scale === 'plantKw') base = plantKw ?? plantEnergy(code, { capacity }).design?.kw_avg ?? 1;
  const out = []; const n = Math.round(hours * 60 / stepMin);
  for (let i = 0; i < n; i++) {
    const h = i * stepMin / 60; const t = new Date(start + h * 3600e3);
    let v = base * (1 + s.amp * Math.sin(2 * Math.PI * ((h % 24) - (s.phase ?? 0)) / 24)) + s.noise * base * gauss(r);
    if (event && h >= event.at && h < event.at + (event.hours ?? 6)) v *= event.type === 'drop' ? (event.factor ?? 0.3) : (event.factor ?? 2.5);
    if (param === 'PH') v = Math.min(9.5, Math.max(5, v)); else if (param !== 'ORP') v = Math.max(0, v);
    out.push({ t: t.toISOString(), v: +v.toFixed(param === 'PH' ? 2 : v > 100 ? 0 : 2) });
  }
  return out;
}
/** สรุปอนุกรม: นับระดับ 5 ขั้น + สถิติ */
export function summarizeSeries(param, series) {
  const key = ALL_PARAM_INFO[param] ? param : infoKey(param, 'effluent');
  const counts = { good: 0, fair: 0, poor: 0, bad: 0, none: 0 }; const vals = [];
  for (const p of series) { counts[levelFor(key, p.v)]++; vals.push(p.v); }
  const n = vals.length; const avg = n ? vals.reduce((a, b) => a + b, 0) / n : null;
  return { key, n, min: n ? Math.min(...vals) : null, max: n ? Math.max(...vals) : null, avg, counts, exceed: series.filter((p) => ['poor', 'bad'].includes(levelFor(key, p.v))) };
}
/** ตัวอย่างข้อมูลที่วิ่งในแต่ละช่วงของสายส่ง (ให้ตรงกับ schema จริงของตาราง observations) */
export function payloadFor(design, item, value, at = new Date().toISOString(), site = 'WWTP01') {
  const code = item.param?.replace(/^(eff|in):/, '') ?? 'X'; const reg = 40001 + (Math.abs(hashStr(item.stage + code)) % 200) * 2;
  return {
    sensor: { signal: '4–20 mA / Modbus RTU', register: `4${String(reg).padStart(4, '0')}`, raw: value, unit: ALL_PARAM_INFO[item.param]?.unit ?? '' },
    logger: { device: 'RTU-01', modbus: { slave: 1, fc: 3, addr: reg, float32: value }, sampled_at: at, buffered: false },
    mqtt: { topic: `envi/${site}/${item.stage}/${code}`, qos: 1, retain: false, payload: { site, stage: item.stage, param: item.param, value, unit: ALL_PARAM_INFO[item.param]?.unit ?? '', at, quality: 'ok' } },
    cloud: { table: 'observations', row: { station_id: '<id ของสถานีใน stations>', observed_at: at, parameter: `${site}:${code}`, value, unit: ALL_PARAM_INFO[item.param]?.unit ?? '', quality: 'ok' }, latest: { station_id: '<id>', parameter: `${site}:${code}`, observed_at: at, value, extra: { type: 'WPMS', code: site, stage: item.stage } } },
    dashboard: { level: levelFor(ALL_PARAM_INFO[item.param] ? item.param : infoKey(item.param, 'effluent'), value), page: 'water-realtime.html' },
  };
}
function hashStr(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// ─────────────────────────────────────────────────────────── URL/บันทึก
export function designToURL(state) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v != null && v !== '' && typeof v !== 'object') p.set(k, String(v));
  if (state.qty) p.set('qty', Object.entries(state.qty).map(([k, v]) => `${k}=${v}`).join(','));
  return p.toString();
}
export function designFromURL(qs) {
  const p = new URLSearchParams(qs); const o = {};
  for (const [k, v] of p.entries()) o[k] = ['cap', 'lat', 'lng', 'seed', 'psh', 'tariff', 'inflow', 'station'].includes(k) ? Number(v) : v;
  if (o.qty) o.qty = Object.fromEntries(String(o.qty).split(',').filter(Boolean).map((s) => { const [k, v] = s.split('='); return [k, Number(v)]; }));
  return o;
}
