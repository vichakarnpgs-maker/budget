// =====================================================================
// SHEETS BACKEND — อ่าน/เขียนข้อมูลใน Google Sheets โดยตรง (ไม่มี Apps Script)
//
// โครงสร้างชีตใน Spreadsheet เดียว:
//   Whitelist          — Email | Role | Departments | EditableIDs
//   Data_academic      — เซลล์ A1 เก็บ JSON ของกลุ่มวิชาการ
//   Data_student       — เซลล์ A1 เก็บ JSON ของกลุ่มกิจการนักเรียน
//   Data_general       — เซลล์ A1 เก็บ JSON ของกลุ่มบริหารทั่วไป
//   Data_budget        — เซลล์ A1 เก็บ JSON ของกลุ่มงบประมาณ
//   Data_personnel     — เซลล์ A1 เก็บ JSON ของกลุ่มบุคคล
//
// การป้องกันข้อมูล:
//   - Sheet แชร์เฉพาะคนที่มีสิทธิ์ (ชั้นแรก — Google จัดการ)
//   - ชีต Whitelist กำหนด role/dept ชั้นสอง (อ่านตอน login)
//   - เซลล์ A1 ของแต่ละ Data_* sheet ควร "Protect range" ให้เฉพาะเจ้าของ Sheet แก้ไขได้
//     (ใช้ Data > Protect sheets and ranges ใน Google Sheets)
// =====================================================================

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// ดึง access_token จาก session (หรือขอใหม่ถ้าหมดอายุ)
async function getAccessToken() {
  if (DEV_MODE) return null; // DEV_MODE ไม่ต้องการ token
  const session = getSession();
  if (!session?.accessToken) throw new Error('กรุณาเข้าสู่ระบบใหม่');
  return session.accessToken;
}

// ---- อ่านข้อมูลกลุ่มงาน -------------------------------------------
async function loadDeptData(deptId) {
  // โหมดทดลอง: ดึงจาก localStorage เหมือนเดิม
  if (DEV_MODE || !SPREADSHEET_ID || SPREADSHEET_ID === '1gt8OSlgf5atgtXx7KPtBRD6gcWGsf_b1COOTE2gS84w') {
    const raw = localStorage.getItem(`edu_data_${deptId}`);
    return raw ? JSON.parse(raw) : [];
  }
  try {
    const token = await getAccessToken();
    const sheetName = `Data_${deptId}`;
    const url = `${1gt8OSlgf5atgtXx7KPtBRD6gcWGsf_b1COOTE2gS84w}/values/${encodeURIComponent(""Whitelist + '!A2')}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return []; // ชีตยังไม่มี = ข้อมูลว่าง
    if (!res.ok) throw new Error(`โหลดข้อมูลไม่สำเร็จ (${res.status})`);
    const data = await res.json();
    const raw = data.values?.[0]?.[0];
    const parsed = raw ? JSON.parse(raw) : [];
    // เก็บ cache ใน localStorage เพื่อ fallback ออฟไลน์
    localStorage.setItem(`edu_data_${deptId}`, JSON.stringify(parsed));
    return parsed;
  } catch (e) {
    console.warn('Sheets API โหลดไม่สำเร็จ ใช้ cache ท้องถิ่นแทน:', e.message);
    const raw = localStorage.getItem(`edu_data_${deptId}`);
    return raw ? JSON.parse(raw) : [];
  }
}

// ---- เขียนข้อมูลกลุ่มงาน ----------------------------------------
async function saveDeptData(deptId, appData) {
  // บันทึก localStorage ก่อนเสมอ (กันข้อมูลหายระหว่างออฟไลน์)
  localStorage.setItem(`edu_data_${deptId}`, JSON.stringify(appData));

  if (DEV_MODE || !SPREADSHEET_ID || SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID') {
    return { ok: true, mode: 'local-only' };
  }

  // ตรวจสิทธิ์ฝั่ง client ก่อน (UX — ป้องกันจริงอยู่ที่ Sheets sharing)
  const session = getSession();
  if (!canAccessDept(session, deptId)) throw new Error('ไม่มีสิทธิ์แก้ไขกลุ่มงานนี้');

  const token = await getAccessToken();
  const sheetName = `Data_${deptId}`;

  // สร้างชีตก่อนถ้ายังไม่มี (ครั้งแรก)
  await ensureSheetExists(token, sheetName);

  const url = `${SHEETS_API}/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + '!A1')}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[JSON.stringify(appData)]] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`บันทึกไม่สำเร็จ: ${err.error?.message || res.status}`);
  }
  return { ok: true, savedAt: new Date().toISOString() };
}

// ---- สร้างชีตใหม่ถ้ายังไม่มี ----------------------------------------
async function ensureSheetExists(token, sheetName) {
  // ตรวจว่ามีชีตชื่อนี้ไหม
  const metaRes = await fetch(`${SHEETS_API}/${SPREADSHEET_ID}?fields=sheets.properties.title`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!metaRes.ok) return;
  const meta = await metaRes.json();
  const exists = (meta.sheets || []).some(s => s.properties.title === sheetName);
  if (exists) return;
  // สร้างชีตใหม่
  await fetch(`${SHEETS_API}/${SPREADSHEET_ID}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
  });
}
