// 白沙屯醫護團｜LINE → Firebase 登入驗證（Cloudflare Worker）
// 收到 LIFF 的 access token → 向 LINE 確認是本頻道、取得 userId → 簽發 Firebase 自訂權杖
// 需要的密鑰（Settings → Variables and Secrets → 類型選 Secret）：
//   SERVICE_ACCOUNT = Firebase 服務帳戶 JSON 檔「整個內容」
// AI 智慧貼上（/parse，只有管理員能用）需要：Settings → Bindings → Workers AI，名稱 AI

const LINE_CHANNEL_ID = '2011820105';
const ALLOWED_ORIGINS = ['https://eurekateamstar-star.github.io'];
// Cloudflare Pages：正式網址 tsushin-buishatun.pages.dev（bst-app-41d、bst-record 為搬家前舊網址）
const PAGES_RE = /^https:\/\/([a-z0-9]+\.)?(tsushin-buishatun|bst-app-41d|bst-record)\.pages\.dev$/;
const originOk = o => ALLOWED_ORIGINS.includes(o) || PAGES_RE.test(o);
const PROJECT_ID = 'linebot-firebase-b1242';
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': originOk(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ ok: true, service: 'bst-auth', configured: !!env.SERVICE_ACCOUNT, ai: !!env.AI });
    if (new URL(req.url).pathname === '/parse') return parseRoute(req, env, json);

    try {
      const { accessToken } = await req.json();
      if (!accessToken) return json({ error: 'missing token' }, 400);

      // 1) 確認 token 是我們的 LINE 頻道發的、還沒過期
      // 兩個 LINE 查詢同時送出，比較快
      const [v, p] = await Promise.all([
        fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken)),
        fetch('https://api.line.me/v2/profile', { headers: { Authorization: 'Bearer ' + accessToken } }),
      ]);
      if (!v.ok) return json({ error: 'invalid token' }, 401);
      const info = await v.json();
      if (String(info.client_id) !== LINE_CHANNEL_ID || !(info.expires_in > 0)) return json({ error: 'wrong channel' }, 401);

      // 2) 用 token 取得 LINE userId（不能偽造）
      if (!p.ok) return json({ error: 'profile failed' }, 401);
      const { userId } = await p.json();
      if (!userId) return json({ error: 'no user' }, 401);

      // 3) 簽發 Firebase 自訂權杖（uid = LINE userId）
      const sa = JSON.parse(env.SERVICE_ACCOUNT);
      const token = await firebaseCustomToken(sa, userId);
      return json({ token, uid: userId });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

// ===== AI 智慧貼上：把一串文字拆成團員名冊欄位 =====
const FIELDS = {
  serial: '序號', joinYear: '加入年份（照原文，例如 108 或 2016）', name: '姓名', lineName: 'LINE 名稱／暱稱',
  birthdayRaw: '出生日期（照原文）', idCard: '身分證字號（1 個英文字母＋9 個數字）', phone: '本人聯絡電話',
  emName: '緊急聯絡人姓名', emRelation: '緊急聯絡人和本人的關係（例如 夫妻、父子、母女）', emPhone: '緊急聯絡人電話',
  shirtSize: '衣服尺寸（例如 M、L、2L、XL）', pantsSize: '褲子尺寸', certText: '證照（例如 EMT1、EMT2、EMTP、護理師、醫師）',
  address: '地址', job: '職業', introducer: '介紹人', education: '學歷／經歷', notes: '其他備註',
};

async function parseRoute(req, env, json) {
  try {
    if (!env.AI) return json({ error: 'AI 尚未設定（Worker 需要 Workers AI 綁定，名稱 AI）' }, 501);
    const { idToken, text } = await req.json();
    if (!idToken || !text) return json({ error: 'missing' }, 400);
    if (String(text).length > 3000) return json({ error: '文字太長（最多 3000 字）' }, 400);

    // 只有管理員可以用：用本人的 Firebase 權杖讀自己的會員資料（權杖假的話 Firestore 會拒絕）
    const uid = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).user_id;
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
      { headers: { Authorization: 'Bearer ' + idToken } });
    if (!r.ok) return json({ error: 'not signed in' }, 401);
    const f = (await r.json()).fields || {};
    if (f.role?.stringValue !== 'admin' || f.status?.stringValue !== 'approved') return json({ error: 'admin only' }, 403);

    const keys = Object.keys(FIELDS);
    const sys = '你是資料整理助手。使用者會貼上一位團員的資料（可能是 LINE 訊息、表單、口語敘述）。'
      + '請把資料放進對應欄位，只能用原文出現的資訊，不可以自己編造；找不到的欄位填空字串。保留原本寫法（日期、電話照原文）。'
      + '「媽媽李美」這種寫法代表緊急聯絡人姓名是李美、關係是母子或母女（依本人性別不明時填「母」）。\n欄位說明：\n'
      + keys.map(k => `${k}: ${FIELDS[k]}`).join('\n');
    const out = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: String(text) }],
      response_format: { type: 'json_schema', json_schema: { type: 'object', properties: Object.fromEntries(keys.map(k => [k, { type: 'string' }])), required: keys } },
      max_tokens: 800, temperature: 0,
    });
    let data = out && out.response;
    if (typeof data === 'string') { const m = data.match(/\{[\s\S]*\}/); data = m ? JSON.parse(m[0]) : {}; }
    const fields = {};
    keys.forEach(k => { const v = data && data[k]; if (v != null && String(v).trim()) fields[k] = String(v).trim(); });
    return json({ fields });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

async function firebaseCustomToken(sa, uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
  };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc(header) + '.' + enc(payload);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return data + '.' + b64url(new Uint8Array(sig));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
