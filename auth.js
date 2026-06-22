// =====================================================================
// AUTH LAYER
// ความปลอดภัยจริงอยู่ที่ฝั่งเซิร์ฟเวอร์ (Apps Script Code.gs) เสมอ:
//   ทุกครั้งที่ "บันทึก" ข้อมูล ตัว idToken (JWT จาก Google) จะถูกส่งไปตรวจสอบ
//   ลายเซ็นกับ Google จริง ๆ ที่ฝั่งเซิร์ฟเวอร์ + เช็ครายชื่ออีเมลที่มีสิทธิ์
//   (whitelist) ก่อนจะยอมเขียนข้อมูลลง Google Sheet ทุกครั้ง
// โค้ดฝั่ง client (ไฟล์นี้) ใช้สำหรับ "ควบคุมหน้าจอ" เท่านั้น (ซ่อน/ล็อกปุ่ม)
// เพื่อ UX ที่ดี แต่ "ไม่ใช่ตัวป้องกันจริง" — ป้องกันจริงอยู่ใน Code.gs
// =====================================================================

// ----------------------------------------------------------------------
// DEV_MODE: โหมดทดลองดูหน้าจอ/UX โดยไม่ต้อง login จริง (ข้าม Google Sign-In)
// ใช้ตอนยังไม่ได้สร้าง Google OAuth Client ID หรือต้องการ demo หน้าจอเฉย ๆ
//   - true  = ข้าม login อัตโนมัติ, จำลองเป็นผู้ใช้ admin เห็น/แก้ได้ทุกกลุ่มงาน
//   - false = ใช้ระบบ Google Sign-In จริงตามปกติ (ต้องตั้งค่า GOOGLE_CLIENT_ID
//             และ APPS_SCRIPT_URL ก่อน — ดูขั้นตอนใน README.md)
// !! ก่อนใช้งานจริงกับข้อมูลโรงเรียน ต้องเปลี่ยนกลับเป็น false เสมอ !!
// ----------------------------------------------------------------------
const DEV_MODE = false;
const DEV_MOCK_SESSION = {
  idToken: 'dev-mode-fake-token',
  email: 'demo.admin@phonngam.ac.th',
  name: 'ผู้ใช้งานทดลอง (DEV MODE)',
  picture: '',
  role: 'admin',
  editableIds: [],
  departments: DEPARTMENTS_FALLBACK_IDS(),
  exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // หมดอายุใน 24 ชม.
};
function DEPARTMENTS_FALLBACK_IDS() {
  // เรียกแบบ lazy เพราะตอนไฟล์นี้โหลด DEPARTMENTS (จาก shared.js) อาจยังไม่ถูกประกาศ
  try { return DEPARTMENTS.map(d => d.id); } catch { return ['academic', 'student', 'general', 'budget', 'personnel']; }
}

// ใส่ Google OAuth Client ID ของโรงเรียนตรงนี้ (สร้างจาก Google Cloud Console)
const GOOGLE_CLIENT_ID = "1080521502773-mt5a7907nseji5upr6ajm0lv6ommeicc.apps.googleusercontent.com";

const SESSION_KEY = '1gt8OSlgf5atgtXx7KPtBRD6gcWGsf_b1COOTE2gS84w';

function getSession() {
  if (DEV_MODE) return DEV_MOCK_SESSION;
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s.exp && Date.now() / 1000 > s.exp) { sessionStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}

function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

// decode JWT แบบ client-side เพื่อเอามาแสดงผล (ชื่อ/รูป/อีเมล) เท่านั้น — ไม่ใช่การยืนยันความถูกต้อง
function decodeJWT(token) {
  const payload = token.split('.')[1];
  const json = decodeURIComponent(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    .split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
  return JSON.parse(json);
}

// เรียกหลัง Google Sign-In สำเร็จ: ส่ง idToken ไปให้เซิร์ฟเวอร์ตรวจสอบสิทธิ์จริง แล้วค่อยสร้าง session
async function handleGoogleCredential(credentialResponse) {
  const idToken = credentialResponse.credential;
  const profile = decodeJWT(idToken);

  let serverPerm = { ok: true, role: 'viewer', editableIds: [], departments: [] };
  if (backendAvailable()) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'verifyLogin', idToken }),
      });
      serverPerm = await res.json();
      if (!serverPerm.ok) { alert('เข้าสู่ระบบไม่สำเร็จ: ' + (serverPerm.error || 'ไม่พบสิทธิ์การใช้งาน')); return false; }
    } catch (e) {
      alert('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ตรวจสอบสิทธิ์ได้ กรุณาลองใหม่');
      return false;
    }
  } else {
    // โหมดทดสอบไม่มี backend: อนุญาตทุกคนเป็น viewer เพื่อทดลองใช้หน้าจอเท่านั้น (ไม่ปลอดภัยสำหรับใช้งานจริง)
    console.warn('APPS_SCRIPT_URL ยังไม่ได้ตั้งค่า ระบบทำงานในโหมดทดสอบ (ไม่มีการตรวจสอบสิทธิ์จริง)');
  }

  const session = {
    idToken, email: profile.email, name: profile.name, picture: profile.picture,
    role: serverPerm.role || 'viewer',
    editableIds: serverPerm.editableIds || [],
    departments: serverPerm.departments || DEPARTMENTS.map(d => d.id),
    exp: profile.exp,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return true;
}

function requireAuth() {
  if (DEV_MODE) return DEV_MOCK_SESSION;
  const s = getSession();
  if (!s) { window.location.href = 'index.html'; return null; }
  return s;
}

function logout() {
  if (DEV_MODE) { alert('ขณะนี้ระบบอยู่ในโหมดทดลอง (DEV_MODE) ปิดการ login ไว้ชั่วคราว จึงไม่มีการออกจากระบบจริง\n\nต้องการปิดโหมดนี้ ให้แก้ DEV_MODE = false ในไฟล์ auth.js'); return; }
  clearSession(); window.location.href = 'index.html';
}

// สิทธิ์แก้ไขรายการ: ผู้ดูแลระบบ (admin) แก้ได้ทุกรายการ, อาจารย์ทั่วไปแก้ได้เฉพาะรายการที่ตน
// ถูก whitelist ไว้ (จับคู่ด้วย item.id หรือ item.ownerEmail ตรงกับอีเมลที่ login)
function canEditItem(session, item) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  if (session.editableIds && session.editableIds.includes(item.id)) return true;
  if (item.ownerEmail && item.ownerEmail.toLowerCase() === session.email.toLowerCase()) return true;
  return false;
}
function canAccessDept(session, deptId) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  return session.departments.includes(deptId);
}
