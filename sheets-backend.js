// =====================================================================
// SHEETS BACKEND — อ่าน/เขียนข้อมูลใน Google Sheets โดยตรง
// ตัวแปร SPREADSHEET_ID และ DEV_MODE โหลดมาจาก auth.js อัตโนมัติ
// =====================================================================

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// ดึง access_token จาก session ปัจจุบัน
async function getAccessToken() {
  if (DEV_MODE) return null;
  const session = getSession();
  if (!session?.accessToken) throw new Error('กรุณาเข้าสู่ระบบใหม่');
  return session.accessToken;
}

// ---- อ่านข้อมูลกลุ่มงาน -------------------------------------------
async function loadDeptData(deptId) {
  // DEV_MODE หรือยังไม่ได้ตั้งค่า → ใช้ localStorage
  if (DEV_MODE || !SPREADSHEET_ID || SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID') {
    const raw = localStorage.getItem(`edu_data_${deptId}`);
    return raw ? JSON.parse(raw) : [];
  }
  try {
    const token = await getAccessToken();
    const sheetName = `Data_${deptId}`;
    const url = `${SHEETS_API}/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + '!A1')}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 400 || res.status === 404) return []; // ชีตยังไม่มี
    if (!res.ok) throw new Error(`โหลดข้อมูลไม่สำเร็จ (${res.status})`);
    const data = await res.json();
    const raw = data.values?.[0]?.[0];
    const parsed = raw ? JSON.parse(raw) : [];
    // เก็บ cache ไว้ใช้ตอนออฟไลน์
    localStorage.setItem(`edu_data_${deptId}`, JSON.stringify(parsed));
    return parsed;
  } catch (e) {
    console.warn('Sheets API ล้มเหลว ใช้ cache แทน:', e.message);
    const raw = localStorage.getItem(`edu_data_${deptId}`);
    return raw ? JSON.parse(raw) : [];
  }
}

// ---- เขียนข้อมูลกลุ่มงาน ------------------------------------------
async function saveDeptData(deptId, appData) {
  // บันทึก localStorage ก่อนเสมอ (กันข้อมูลหายตอนออฟไลน์)
  localStorage.setItem(`edu_data_${deptId}`, JSON.stringify(appData));

  if (DEV_MODE || !SPREADSHEET_ID || SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID') {
    return { ok: true, mode: 'local-only' };
  }

  const session = getSession();
  if (!canAccessDept(session, deptId)) throw new Error('ไม่มีสิทธิ์แก้ไขกลุ่มงานนี้');

  const token = await getAccessToken();
  const sheetName = `Data_${deptId}`;

  // สร้างชีตใหม่อัตโนมัติถ้ายังไม่มี
  await ensureSheetExists(token, sheetName);

  const url = `${SHEETS_API}/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + '!A1')}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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
  const metaRes = await fetch(
    `${SHEETS_API}/${SPREADSHEET_ID}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) return;
  const meta = await metaRes.json();
  const exists = (meta.sheets || []).some(s => s.properties.title === sheetName);
  if (exists) return;
  // สร้างชีตใหม่
  await fetch(`${SHEETS_API}/${SPREADSHEET_ID}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    }),
  });
}
