// =====================================================================
// CORE DATA LAYER — shared by dashboard.html, data-entry.html, import.html
// =====================================================================

// ---- 1) Department configuration -------------------------------------
// NOTE: ปรับชื่อ/สี/รหัสกลุ่มงานที่ 5 ได้ตรงนี้ที่เดียว ระบบทั้งหมดจะอัปเดตตาม
const DEPARTMENTS = [
  { id: 'academic',   name: 'กลุ่มบริหารวิชาการ',        short: 'วิชาการ',        color: '#4f46e5' },
  { id: 'student',    name: 'กลุ่มบริหารกิจการนักเรียน',   short: 'กิจการนักเรียน',  color: '#e11d48' },
  { id: 'general',    name: 'กลุ่มบริหารทั่วไป',          short: 'บริหารทั่วไป',    color: '#0284c7' },
  { id: 'budget',     name: 'กลุ่มบริหารงบประมาณ',        short: 'งบประมาณ',       color: '#059669' },
  // กลุ่มงานที่ 5 — ใส่เป็น "กลุ่มบริหารงานบุคคล" ตามโครงสร้าง 5 กลุ่มงานมาตรฐานของสถานศึกษา
  // หากชื่อจริงของโรงเรียนไม่ตรง แก้ name/short ตรงนี้ที่เดียวพอ
  { id: 'personnel',  name: 'กลุ่มบริหารงานบุคคล',        short: 'บุคคล',          color: '#d97706' },
];
function getDept(id) { return DEPARTMENTS.find(d => d.id === id); }

// ---- 2) Apps Script backend endpoint ----------------------------------
// วาง URL ของ Google Apps Script Web App (หลัง Deploy) ตรงนี้
// ถ้าปล่อยว่าง ระบบจะทำงานแบบ local-only (เก็บใน localStorage ของเครื่อง) เพื่อทดสอบ
const APPS_SCRIPT_URL = ""; // เช่น "https://script.google.com/macros/s/XXXXX/exec"

function backendAvailable() { return !!APPS_SCRIPT_URL; }

async function callBackend(action, payload) {
  if (!backendAvailable()) return null;
  const idToken = getSession()?.idToken || '';
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain หลีกเลี่ยง CORS preflight บน Apps Script
    body: JSON.stringify({ action, idToken, payload }),
  });
  if (!res.ok) throw new Error('Backend error: ' + res.status);
  return await res.json();
}

// ---- 3) Local storage fallback (per department) -----------------------
function localKey(deptId) { return `edu_data_${deptId}`; }

async function loadDeptData(deptId) {
  if (backendAvailable()) {
    try {
      const result = await callBackend('loadData', { dept: deptId });
      if (result && result.ok) return result.data || [];
    } catch (e) { console.warn('Backend load failed, falling back to local copy', e); }
  }
  const raw = localStorage.getItem(localKey(deptId));
  return raw ? JSON.parse(raw) : [];
}

async function saveDeptData(deptId, appData) {
  localStorage.setItem(localKey(deptId), JSON.stringify(appData)); // เก็บสำเนาเครื่องเสมอ (กันข้อมูลหายระหว่างออฟไลน์)
  if (backendAvailable()) {
    const result = await callBackend('saveData', { dept: deptId, data: appData });
    if (!result || !result.ok) throw new Error(result?.error || 'บันทึกไปเซิร์ฟเวอร์ไม่สำเร็จ');
    return result;
  }
  return { ok: true, mode: 'local-only' };
}

// ---- 4) CSV → hierarchical appData -------------------------------------
// คอลัมน์อ้างอิงจากไฟล์ Excel ต้นแบบ:
// ที่ | โครงการ/งาน/กิจกรรม | งบประมาณจัดสรร | อุดหนุน | พัฒนาผู้เรียน | รายได้ฯ | เชิงปริมาณ | เชิงคุณภาพ | ผู้รับผิดชอบ | หมายเหตุ | อีเมลผู้รับผิดชอบ(ถ้ามี)
//
// กฎการจับระดับชั้นจากคอลัมน์ "ที่":
//  - เลขจำนวนเต็ม (เช่น 1, 2, 3)      -> ระดับ "โครงการ" (project)
//  - เลขทศนิยม X.Y (เช่น 1.1, 8.2)   -> ระดับ "งาน" (work) ลูกของโครงการล่าสุด
//  - ว่าง (blank)                     -> ถ้ามี "งาน" ปัจจุบันอยู่ -> เป็น "กิจกรรมย่อย" (activity) ของงานนั้น
//                                         ถ้าไม่มี "งาน" ปัจจุบัน -> เป็น "งาน" แบบไม่มีเลข (ลูกตรงของโครงการ)
//  - งาน/โครงการที่ไม่มีลูกต่อ (leaf) จะกรอกยอดใช้จ่ายรายครั้งได้โดยตรง
function parseCSVToAppData(csvText, deptId) {
  const rows = robustCSVParse(csvText);
  if (!rows.length) return [];
  // ข้ามแถวหัวตาราง (heuristic: แถวแรกที่คอลัมน์ 2 เป็นคำว่า "โครงการ" หรือไม่ใช่ตัวเลข/ว่าง)
  let startIdx = 0;
  if (rows[0] && /โครงการ|ชื่อ|งาน|กิจกรรม/.test(rows[0][1] || '')) startIdx = 1;

  const appData = [];
  let currentProject = null, currentWork = null, autoId = 0;
  const nextId = () => `${deptId}_${++autoId}`;

  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !String(c || '').trim())) continue;
    const idxRaw = String(r[0] ?? '').trim();
    const name = String(r[1] ?? '').trim();
    if (!name) continue;
    if (/รวมเป็นเงินทั้งสิ้น|รวมทั้งสิ้น|^รวม/.test(name)) continue; // ข้ามแถวสรุปท้ายตาราง

    const budgetTotal = parseNum(r[2]);
    const sub0 = parseNum(r[3]); // อุดหนุน
    const sub1 = parseNum(r[4]); // พัฒนาผู้เรียน
    const sub2 = parseNum(r[5]); // รายได้สถานศึกษา
    // คอลัมน์เชิงปริมาณจาก Excel ต้นแบบ คือ "ค่าเป้าหมาย" (ตัวเลข) นำมาใช้เป็นเป้าหมายเริ่มต้น
    // ส่วน "ผลสำเร็จจริง" ยังไม่มีในไฟล์ต้นแบบ ปล่อยว่างไว้กรอกตอนรายงานผลภายหลัง
    const target = parseNum(r[6]);
    const owner = String(r[8] ?? '').trim();
    const note = String(r[9] ?? '').trim();
    const ownerEmail = String(r[10] ?? '').trim();

    // ถ้าไม่มีคอลัมน์แยกประเภทงบ ให้ใส่ยอดรวมไว้ที่ "อุดหนุน" เป็นค่าเริ่มต้น
    const subBudgets = (sub0 || sub1 || sub2) ? [sub0, sub1, sub2] : [budgetTotal || 0, 0, 0];

    const isInt = /^\d+$/.test(idxRaw);
    const isDecimal = /^\d+\.\d+$/.test(idxRaw);

    // ถ้าคอลัมน์ "ที่" มีข้อความแปลกปลอม (ไม่ใช่ว่าง/เลขเต็ม/ทศนิยม) ให้ถือว่าเป็นแถวหัวตาราง
    // หรือข้อมูล meta ที่หลงเหลือมา (เช่น คัดลอกมาทั้งแถวหัวคอลัมน์ 2 ชั้นจาก Excel) แล้วข้ามทิ้ง
    if (idxRaw !== '' && !isInt && !isDecimal) continue;

    let item;
    if (isInt) {
      item = { id: nextId(), type: 'project', indexNum: idxRaw, name, owner, ownerEmail, note };
      appData.push(item);
      currentProject = item; currentWork = null;
    } else if (isDecimal) {
      item = { id: nextId(), type: 'work', parentId: currentProject?.id, indexNum: idxRaw, name, subBudgets, owner, ownerEmail, note, success: { target, actual: null } };
      appData.push(item);
      currentWork = item;
    } else {
      // ที่ ว่าง
      if (currentWork) {
        item = { id: nextId(), type: 'activity', parentId: currentWork.id, indexNum: '', name, subBudgets, owner, ownerEmail, note, success: { target, actual: null } };
      } else {
        item = { id: nextId(), type: 'work', parentId: currentProject?.id, indexNum: '', name, subBudgets, owner, ownerEmail, note, success: { target, actual: null } };
      }
      appData.push(item);
    }
  }
  initDataFields(appData);
  return appData;
}

function parseNum(v) {
  if (v === undefined || v === null) return 0;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// CSV parser ที่รองรับ comma/tab delimiter, quoted field, ขึ้นบรรทัดใหม่ในเซลล์
function robustCSVParse(text) {
  const delim = text.indexOf('\t') !== -1 && text.split('\n')[0].split('\t').length >= text.split('\n')[0].split(',').length ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- 5) Field init + hierarchy rollup ----------------------------------
const SPEND_SLOTS = 8; // จำนวนครั้งการเบิกจ่ายเริ่มต้น

function initDataFields(appData) {
  appData.forEach(item => {
    if (!item.subBudgets) item.subBudgets = [0, 0, 0];
    if (!item.spendings) item.spendings = Array(SPEND_SLOTS).fill(null).map(() => ({ amt: 0, date: '', score: 0 }));
    else item.spendings = item.spendings.map(sp => ({ amt: sp?.amt || 0, date: sp?.date || '', score: sp?.score || 0 }));
    while (item.spendings.length < SPEND_SLOTS) item.spendings.push({ amt: 0, date: '', score: 0 });
    // success.target / success.actual: ค่าเป้าหมายเชิงปริมาณที่ตั้งไว้ (ตอนวางแผน) เทียบกับผลสำเร็จจริง (ตอนรายงานผล)
    // เป็นคนละส่วนกับคะแนนความพึงพอใจที่ใช้คำนวณ "เชิงคุณภาพ"
    if (!item.success || typeof item.success !== 'object') item.success = {};
    item.success = { target: Number(item.success.target) || 0, actual: item.success.actual === undefined || item.success.actual === '' ? null : Number(item.success.actual) };
    if (item.owner === undefined) item.owner = '';
    if (item.ownerEmail === undefined) item.ownerEmail = '';
    if (item.note === undefined) item.note = '';
  });
}

// คืนจำนวนลูกของ item (ใช้ตัดสินว่าเป็น leaf หรือไม่ -> leaf กรอกยอดใช้จ่ายเองได้)
function getChildren(appData, pid) { return appData.filter(x => x.parentId === pid); }
// แก้บั๊ก: ไม่ว่าจะเป็นโครงการ/งาน/กิจกรรม หากไม่มีลูกเลย ถือเป็น leaf กรอกยอดใช้จ่ายได้เสมอ
function isLeaf(appData, item) { return getChildren(appData, item.id).length === 0; }

// ---- 5b) สูตรแปลผลอัตโนมัติ (อ้างอิงสูตร Excel ที่ผู้ใช้กำหนด) -------------
// คะแนนเฉลี่ยความพึงพอใจ (0-5) -> เทียบบัญญัติไตรยางศ์เป็นร้อยละ 100 (Z)
function avgScorePercent(item) {
  const scored = (item.spendings || []).filter(sp => Number(sp.score) > 0);
  if (!scored.length) return null;
  const avg = scored.reduce((s, sp) => s + Number(sp.score), 0) / scored.length;
  return avg / 5 * 100;
}
// เชิงคุณภาพ (ระดับรายชิ้นงาน/กิจกรรม)
function qualityGrade(z) {
  if (z === null || z === undefined || z === '') return '-';
  if (z >= 87.75) return 'ดีเยี่ยม';
  if (z >= 62.75) return 'ดีมาก';
  if (z >= 37.75) return 'ดี';
  if (z >= 12.75) return 'พอใช้';
  return 'ปรับปรุง';
}
// ผลสรุปโครงการ (ระดับโครงการ/งาน เทียบกับค่าเป้าหมาย)
function resultLabel(z) {
  if (z === null || z === undefined || z === '') return '-';
  if (z >= 87.75) return 'สูงกว่าค่าเป้าหมาย';
  if (z >= 62.75) return 'เป็นไปตามค่าเป้าหมาย';
  if (z >= 37.75) return 'ใกล้เคียงค่าเป้าหมาย';
  if (z >= 12.75) return 'ต่ำกว่าค่าเป้าหมาย';
  return 'ต้องปรับปรุงเร่งด่วน';
}
// แจ้งเตือนการใช้จ่ายงบประมาณ
function spendAlertLabel(remaining) {
  if (remaining < 0) return 'ใช้จ่ายเกินงบประมาณ';
  if (remaining === 0) return 'สมดุลงบประมาณ';
  return '';
}
// ร้อยละผลสำเร็จจริงเทียบค่าเป้าหมายที่ตั้งไว้ (ใช้กับ "ผลการสรุปโครงการ" เท่านั้น — คนละส่วนกับคะแนนพึงพอใจ)
function achievementPercent(success) {
  if (!success || !success.target || success.actual === null || success.actual === undefined) return null;
  return success.actual / success.target * 100;
}

// รวมยอดจากล่างขึ้นบน 3 ระดับ (Project <- Work <- Activity), ข้าม leaf ที่กรอกตรง
function calculateHierarchy(appData) {
  const children = pid => getChildren(appData, pid);

  appData.forEach(item => {
    const hasChildren = children(item.id).length > 0;
    if (hasChildren) { // เฉพาะโหนดที่มีลูกเท่านั้นที่สะสมจากลูก (leaf เก็บค่าที่กรอกเอง)
      item.subBudgets = [0, 0, 0];
      item.spendings = Array(SPEND_SLOTS).fill(null).map(() => ({ amt: 0, date: '', score: 0 }));
      item._scoreSum = 0; item._scoreCount = 0;
      item._rollupTarget = 0; item._rollupActual = 0; item._rollupHasActual = false;
    } else {
      const scored = item.spendings.filter(sp => Number(sp.score) > 0);
      item._scoreSum = scored.reduce((s, sp) => s + Number(sp.score), 0);
      item._scoreCount = scored.length;
      item._rollupTarget = Number(item.success?.target || 0);
      item._rollupActual = Number(item.success?.actual || 0);
      item._rollupHasActual = item.success?.actual !== null && item.success?.actual !== undefined;
    }
  });

  // งาน <- กิจกรรมย่อย
  appData.filter(x => x.type === 'work').forEach(work => {
    const acts = children(work.id);
    if (acts.length) {
      acts.forEach(act => {
        for (let i = 0; i < 3; i++) work.subBudgets[i] += Number(act.subBudgets[i] || 0);
        act.spendings.forEach((sp, idx) => work.spendings[idx].amt += Number(sp.amt || 0));
        work._scoreSum += act._scoreSum || 0; work._scoreCount += act._scoreCount || 0;
        work._rollupTarget += act._rollupTarget || 0; work._rollupActual += act._rollupActual || 0;
        work._rollupHasActual = work._rollupHasActual || act._rollupHasActual;
      });
    }
    work.budget = work.subBudgets.reduce((a, b) => a + b, 0);
  });

  // โครงการ <- งาน
  appData.filter(x => x.type === 'project').forEach(proj => {
    const works = children(proj.id);
    works.forEach(w => {
      for (let i = 0; i < 3; i++) proj.subBudgets[i] += Number(w.subBudgets[i] || 0);
      w.spendings.forEach((sp, idx) => proj.spendings[idx].amt += Number(sp.amt || 0));
      proj._scoreSum += w._scoreSum || 0; proj._scoreCount += w._scoreCount || 0;
      proj._rollupTarget += w._rollupTarget || 0; proj._rollupActual += w._rollupActual || 0;
      proj._rollupHasActual = proj._rollupHasActual || w._rollupHasActual;
    });
    proj.budget = proj.subBudgets.reduce((a, b) => a + b, 0);
  });

  // สรุปยอดรวมทั้งหมด (ใช้ทำ footer / dashboard)
  const totals = { budget: 0, spent: 0, sub: [0, 0, 0], spendByTime: Array(SPEND_SLOTS).fill(0), scoreSum: 0, scoreCount: 0, rollupTarget: 0, rollupActual: 0 };
  appData.filter(x => x.type === 'project').forEach(item => {
    totals.budget += item.budget;
    for (let i = 0; i < 3; i++) totals.sub[i] += item.subBudgets[i];
    item.spendings.forEach((s, idx) => { totals.spent += Number(s.amt || 0); totals.spendByTime[idx] += Number(s.amt || 0); });
    totals.scoreSum += item._scoreSum || 0; totals.scoreCount += item._scoreCount || 0;
    totals.rollupTarget += item._rollupTarget || 0; totals.rollupActual += item._rollupActual || 0;
  });
  totals.remaining = totals.budget - totals.spent;
  totals.avgScorePct = totals.scoreCount ? (totals.scoreSum / totals.scoreCount) / 5 * 100 : null;
  totals.achievementPct = totals.rollupTarget ? (totals.rollupActual / totals.rollupTarget * 100) : null;
  return totals;
}

// ---- 6) Formatting helpers ----------------------------------------------
function thb(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function thbShort(n) { return Number(n || 0).toLocaleString('th-TH'); }
