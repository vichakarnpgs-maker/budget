// =====================================================================
// AUTH LAYER — Google Sign-In + Google Sheets API (ไม่ต้อง Apps Script)
//
// สถาปัตยกรรม:
//   1) google.accounts.id  → ได้ id_token (JWT) สำหรับยืนยันตัวตน (email/name/picture)
//   2) google.accounts.oauth2 → ได้ access_token สำหรับเรียก Sheets API โดยตรง
//
// ความปลอดภัย:
//   - Google Sheet ที่ใช้เก็บข้อมูลแชร์เฉพาะคนที่มีสิทธิ์ (Viewer/Editor ตาม role)
//     → คนที่ไม่ได้รับแชร์จะ 403 ทันที ก่อนถึง whitelist ชั้นสอง
//   - whitelist ใน Sheet ชีต "Whitelist" ควบคุม role/กลุ่มงาน/รายการที่แก้ไขได้
//   - access_token มีอายุ 1 ชม. refresh อัตโนมัติ ไม่ต้อง login ซ้ำ
// =====================================================================

// ---- ตั้งค่าที่ต้องกรอก 2 ค่า ----------------------------------------

// Google OAuth Client ID (จาก Google Cloud Console → APIs & Services → Credentials)
const GOOGLE_CLIENT_ID = "1080521502773-mt5a7907nseji5upr6ajm0lv6ommeicc.apps.googleusercontent.com";

// Spreadsheet ID ของ Google Sheet ที่ใช้เก็บข้อมูล
// (เปิด Sheet → ดู URL: docs.google.com/spreadsheets/d/<<< ID ตรงนี้ >>>/edit)
const SPREADSHEET_ID = "1gt8OSlgf5atgtXx7KPtBRD6gcWGsf_b1COOTE2gS84w";

// Scope ที่ขอ: อ่าน profile + อ่าน/เขียน Sheets
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets email profile openid";

// -----------------------------------------------------------------------

// ----------------------------------------------------------------------
// DEV_MODE: โหมดทดลองดูหน้าจอโดยไม่ต้อง login จริง
// true  = ข้าม login, จำลองเป็น admin เห็น/แก้ไขได้ทุกกลุ่มงาน
// false = ใช้ Google Sign-In + Sheets API จริง (ต้องตั้งค่า CLIENT_ID และ SPREADSHEET_ID ก่อน)
// !! ต้องเปลี่ยนเป็น false ก่อนใช้งานจริงกับข้อมูลโรงเรียน !!
// ----------------------------------------------------------------------
const DEV_MODE = false;

const DEV_MOCK_SESSION = {
  email: 'demo.admin@phonngam.ac.th',
  name: 'ผู้ใช้งานทดลอง (DEV MODE)',
  picture: '',
  role: 'admin',
  editableIds: [],
  departments: ['academic','student','general','budget','personnel'],
  accessToken: null,
  exp: Math.floor(Date.now()/1000) + 86400,
};

const SESSION_KEY = 'edu_session_v2';

function getSession() {
  if (DEV_MODE) return DEV_MOCK_SESSION;
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s.exp && Date.now()/1000 > s.exp) { sessionStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

// ---- Token client สำหรับ access_token (Sheets API) -------------------
let _tokenClient = null;
let _tokenResolve = null;

function initTokenClient() {
  if (typeof google === 'undefined' || !google.accounts?.oauth2) return;
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SHEETS_SCOPE,
    callback: (resp) => {
      if (_tokenResolve) { _tokenResolve(resp); _tokenResolve = null; }
    },
  });
}

// ขอ access_token (popup consent ครั้งแรก, silent refresh ครั้งถัดไป)
function requestAccessToken() {
  return new Promise((resolve, reject) => {
    if (!_tokenClient) { reject(new Error('Token client ยังไม่พร้อม')); return; }
    _tokenResolve = (resp) => {
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp.access_token);
    };
    _tokenClient.requestAccessToken({ prompt: '' }); // '' = silent ถ้าเคย consent แล้ว
  });
}

// ---- decode JWT id_token (เพื่อเอา email/name/picture เท่านั้น) --------
function decodeJWT(token) {
  const payload = token.split('.')[1];
  const json = decodeURIComponent(atob(payload.replace(/-/g,'+').replace(/_/g,'/'))
    .split('').map(c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));
  return JSON.parse(json);
}

// ---- อ่าน Whitelist จาก Google Sheet ---------------------------------
async function loadWhitelist(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Whitelist!A2:D200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`ไม่สามารถอ่าน Whitelist ได้ (${res.status}) — ตรวจสอบว่า Sheet แชร์ให้อีเมลนี้แล้ว`);
  const data = await res.json();
  return (data.values || []).map(r => ({
    email: (r[0]||'').trim().toLowerCase(),
    role:  (r[1]||'editor').trim(),
    departments: (r[2]||'').split(',').map(s=>s.trim()).filter(Boolean),
    editableIds: (r[3]||'').split(',').map(s=>s.trim()).filter(Boolean),
  }));
}

// ---- flow หลัก: id credential → ขอ access_token → อ่าน whitelist ----
async function handleGoogleCredential(credentialResponse) {
  const profile = decodeJWT(credentialResponse.credential);
  let accessToken;
  try {
    accessToken = await requestAccessToken();
  } catch (e) {
    alert('ไม่สามารถขอสิทธิ์เข้าถึง Google Sheets ได้: ' + e.message);
    return false;
  }
  let perm;
  try {
    const whitelist = await loadWhitelist(accessToken);
    perm = whitelist.find(w => w.email === profile.email.toLowerCase());
  } catch (e) {
    alert(e.message); return false;
  }
  if (!perm) {
    alert('อีเมลนี้ยังไม่ได้รับสิทธิ์เข้าใช้งานระบบ\nกรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มสิทธิ์ใน Sheet "Whitelist"');
    return false;
  }
  const session = {
    email: profile.email, name: profile.name, picture: profile.picture,
    role: perm.role, editableIds: perm.editableIds, departments: perm.departments,
    accessToken, exp: profile.exp,
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
  if (DEV_MODE) { alert('อยู่ในโหมดทดลอง (DEV_MODE = true) — ไม่มีการ logout จริง\nแก้ DEV_MODE = false ใน auth.js เพื่อเปิดใช้ระบบจริง'); return; }
  if (typeof google !== 'undefined') google.accounts.id.disableAutoSelect();
  clearSession(); window.location.href = 'index.html';
}

// ---- ตรวจสิทธิ์การแก้ไขรายการ (ฝั่ง client สำหรับ UX) ---------------
function canEditItem(session, item) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  if (session.editableIds?.includes(item.id)) return true;
  if (item.ownerEmail && item.ownerEmail.toLowerCase() === session.email?.toLowerCase()) return true;
  return false;
}
function canAccessDept(session, deptId) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  return session.departments?.includes(deptId) ?? false;
}
