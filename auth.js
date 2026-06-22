// =====================================================================
// AUTH LAYER — ใช้ Google OAuth2 Token Client flow เดียว (เรียบง่าย เสถียรกว่า)
//
// flow: กดปุ่ม Login → popup ขอสิทธิ์ Sheets → ได้ access_token
//       → เรียก userinfo endpoint ดึง email/ชื่อ/รูป
//       → อ่าน Whitelist ใน Sheet → สร้าง session
// =====================================================================

const GOOGLE_CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const SPREADSHEET_ID   = "YOUR_SPREADSHEET_ID";
const SHEETS_SCOPE     = "https://www.googleapis.com/auth/spreadsheets openid email profile";

// DEV_MODE: true = ข้าม login ดู UX ได้เลย / false = ใช้งานจริง
const DEV_MODE = false;

const DEV_MOCK_SESSION = {
  email: 'demo.admin@phonngam.ac.th', name: 'ผู้ใช้ทดลอง (DEV MODE)', picture: '',
  role: 'admin', editableIds: [], departments: ['academic','student','general','budget','personnel'],
  accessToken: null, exp: Math.floor(Date.now()/1000) + 86400,
};

const SESSION_KEY = 'edu_session_v3';

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

// ---- Token Client (flow เดียว ไม่มี race condition) ------------------
let _tokenClient = null;
let _loginResolve = null;
let _loginReject  = null;

function initTokenClient() {
  if (!window.google?.accounts?.oauth2) return false;
  if (_tokenClient) return true;
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SHEETS_SCOPE,
    callback: async (resp) => {
      if (resp.error) {
        if (_loginReject) _loginReject(new Error(resp.error));
        _loginResolve = _loginReject = null;
        return;
      }
      if (_loginResolve) {
        _loginResolve(resp.access_token);
        _loginResolve = _loginReject = null;
      }
    },
  });
  return true;
}

function getAccessTokenViaPopup() {
  return new Promise((resolve, reject) => {
    if (!initTokenClient()) {
      reject(new Error('Google script ยังโหลดไม่เสร็จ กรุณา Refresh หน้าเว็บ'));
      return;
    }
    _loginResolve = resolve;
    _loginReject  = reject;
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

// ---- ดึง profile จาก userinfo endpoint (ใช้ access_token ที่ได้) -----
async function getUserProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('ดึงข้อมูลโปรไฟล์ไม่สำเร็จ');
  return res.json(); // { email, name, picture, exp, ... }
}

// ---- อ่าน Whitelist จาก Google Sheet --------------------------------
async function loadWhitelist(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Whitelist!A2:D200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`อ่าน Whitelist ไม่สำเร็จ (${res.status}) — ตรวจสอบว่า Sheet แชร์ให้อีเมลนี้แล้ว`);
  const data = await res.json();
  return (data.values || []).map(r => ({
    email:       (r[0]||'').trim().toLowerCase(),
    role:        (r[1]||'editor').trim(),
    departments: (r[2]||'').split(',').map(s=>s.trim()).filter(Boolean),
    editableIds: (r[3]||'').split(',').map(s=>s.trim()).filter(Boolean),
  }));
}

// ---- flow หลัก: เรียกจากปุ่ม Login ที่ index.html ------------------
async function handleLogin() {
  let accessToken;
  try {
    accessToken = await getAccessTokenViaPopup();
  } catch (e) {
    alert('ขอสิทธิ์ไม่สำเร็จ: ' + e.message);
    return false;
  }

  let profile;
  try {
    profile = await getUserProfile(accessToken);
  } catch (e) {
    alert('ดึงข้อมูลผู้ใช้ไม่สำเร็จ: ' + e.message);
    return false;
  }

  let perm;
  try {
    const whitelist = await loadWhitelist(accessToken);
    perm = whitelist.find(w => w.email === profile.email.toLowerCase());
  } catch (e) {
    alert(e.message);
    return false;
  }

  if (!perm) {
    alert(`อีเมล ${profile.email} ยังไม่ได้รับสิทธิ์เข้าใช้งานระบบ\nกรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มสิทธิ์ใน Sheet "Whitelist"`);
    return false;
  }

  const session = {
    email: profile.email, name: profile.name, picture: profile.picture,
    role: perm.role, editableIds: perm.editableIds, departments: perm.departments,
    accessToken, exp: Math.floor(Date.now()/1000) + 3600, // 1 ชม.
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
  if (DEV_MODE) { alert('DEV MODE — ไม่มีการ logout จริง'); return; }
  if (window.google?.accounts?.oauth2 && getSession()?.accessToken) {
    google.accounts.oauth2.revoke(getSession().accessToken, () => {});
  }
  clearSession();
  window.location.href = 'index.html';
}

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
