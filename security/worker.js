// 白沙屯醫護團｜LINE → Firebase 登入驗證（Cloudflare Worker）
// 收到 LIFF 的 access token → 向 LINE 確認是本頻道、取得 userId → 簽發 Firebase 自訂權杖
// 需要的密鑰（Settings → Variables and Secrets → 類型選 Secret）：
//   SERVICE_ACCOUNT = Firebase 服務帳戶 JSON 檔「整個內容」
// AI 智慧貼上（/parse，只有管理員能用）需要：Settings → Bindings → Workers AI，名稱 AI
// LINE 圖文選單（/menu、/menu-setup）需要 Secret：LINE_BOT_TOKEN = 官方帳號 Messaging API 的 Channel access token（長期）

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
    if (req.method !== 'POST') return json({ ok: true, service: 'bst-auth', configured: !!env.SERVICE_ACCOUNT, ai: !!env.AI, lineBot: !!env.LINE_BOT_TOKEN });
    const path = new URL(req.url).pathname;
    if (path === '/parse') return parseRoute(req, env, json);
    if (path === '/menu') return menuRoute(req, env, json);
    if (path === '/menu-setup') return menuSetupRoute(req, env, json);

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

// ===== LINE 圖文選單 =====
// 兩種選單：guest（預設，沒開通的人）、member（審核通過的團員）。用 alias 記住目前的選單 ID，不用另外存。
const SITE = 'https://tsushin-buishatun.pages.dev';
const LIFF = id => 'https://liff.line.me/' + id;
const MENUS = {
  guest: { alias: 'bst-guest', name: '白沙屯醫護團｜訪客', areas: [
    { type: 'uri', label: '會員中心', uri: LIFF('2011820105-x1KU6xLW') },
    { type: 'uri', label: '入團申請', uri: SITE + '/join/' },
    { type: 'message', label: '聯絡管理員', text: '聯絡管理員' },
  ] },
  member: { alias: 'bst-member', name: '白沙屯醫護團｜團員', areas: [
    { type: 'uri', label: '會員中心', uri: LIFF('2011820105-x1KU6xLW') },
    { type: 'uri', label: '物資倉庫', uri: LIFF('2011820105-ofRs4ehy') },
    { type: 'uri', label: '救護紀錄表', uri: LIFF('2011820105-6oXAxIEi') },
  ] },
};
const lineApi = (env, path, opt = {}) => fetch((opt.data ? 'https://api-data.line.me' : 'https://api.line.me') + path, {
  method: opt.method || 'GET',
  headers: { Authorization: 'Bearer ' + env.LINE_BOT_TOKEN, ...(opt.type ? { 'Content-Type': opt.type } : {}) },
  body: opt.body,
});
const uidOfToken = t => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).user_id;
async function fsUser(idToken, uid) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
    { headers: { Authorization: 'Bearer ' + idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error('not allowed'), { code: r.status === 403 ? 403 : 401 });
  const f = (await r.json()).fields || {};
  const v = k => f[k] && (f[k].stringValue ?? f[k].booleanValue);
  return { role: v('role'), status: v('status'), adminMember: v('adminMember') === true };
}
const memberAdmin = u => !!u && u.status === 'approved' && (u.role === 'admin' || u.adminMember);

// 依會員狀態切換某人的選單：{ idToken, uid? }，uid 省略＝自己；改別人要會員中心管理員
async function menuRoute(req, env, json) {
  try {
    if (!env.LINE_BOT_TOKEN) return json({ error: 'LINE_BOT_TOKEN 尚未設定' }, 501);
    const { idToken, uid } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = uidOfToken(idToken);
    const meDoc = await fsUser(idToken, me);
    const target = uid || me;
    if (target !== me && !memberAdmin(meDoc)) return json({ error: 'admin only' }, 403);
    const u = target === me ? meDoc : await fsUser(idToken, target);
    const kind = u && u.status === 'approved' ? 'member' : 'guest';
    let r;
    if (kind === 'member') {
      const a = await lineApi(env, '/v2/bot/richmenu/alias/' + MENUS.member.alias);
      if (!a.ok) return json({ error: '選單還沒發佈（請管理員先按「發佈 LINE 圖文選單」）' }, 409);
      r = await lineApi(env, `/v2/bot/user/${target}/richmenu/${(await a.json()).richMenuId}`, { method: 'POST' });
    } else {
      r = await lineApi(env, `/v2/bot/user/${target}/richmenu`, { method: 'DELETE' });   // 回到預設（訪客）選單
    }
    return json({ ok: r.ok, kind, line: r.ok ? undefined : await r.text() });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, e && e.code || 500);
  }
}

// 建立／更新兩個選單（只有最高管理員）：上傳 SITE/richmenu/{guest,member}.png，訪客選單設為預設
async function menuSetupRoute(req, env, json) {
  try {
    if (!env.LINE_BOT_TOKEN) return json({ error: 'LINE_BOT_TOKEN 尚未設定' }, 501);
    const { idToken } = await req.json();
    const meDoc = await fsUser(idToken, uidOfToken(idToken));
    if (!meDoc || meDoc.status !== 'approved' || meDoc.role !== 'admin') return json({ error: 'admin only' }, 403);
    const out = {};
    for (const [key, m] of Object.entries(MENUS)) {
      const W = 2500, H = 843, cw = Math.floor(W / m.areas.length);
      const body = {
        size: { width: W, height: H }, selected: true, name: m.name, chatBarText: '選單',
        areas: m.areas.map((a, i) => ({ bounds: { x: i * cw, y: 0, width: i === m.areas.length - 1 ? W - i * cw : cw, height: H }, action: a })),
      };
      const c = await lineApi(env, '/v2/bot/richmenu', { method: 'POST', type: 'application/json', body: JSON.stringify(body) });
      if (!c.ok) return json({ error: `建立 ${key} 失敗：` + await c.text() }, 502);
      const id = (await c.json()).richMenuId;
      const img = await fetch(`${SITE}/richmenu/${key}.png?v=${Date.now()}`);
      if (!img.ok) return json({ error: `讀不到 ${key}.png` }, 502);
      const up = await lineApi(env, `/v2/bot/richmenu/${id}/content`, { method: 'POST', data: true, type: 'image/png', body: await img.arrayBuffer() });
      if (!up.ok) return json({ error: `上傳 ${key} 圖片失敗：` + await up.text() }, 502);
      // alias 指到新選單，再刪掉舊的
      const old = await lineApi(env, '/v2/bot/richmenu/alias/' + m.alias);
      const oldId = old.ok ? (await old.json()).richMenuId : null;
      const al = oldId
        ? await lineApi(env, '/v2/bot/richmenu/alias/' + m.alias, { method: 'POST', type: 'application/json', body: JSON.stringify({ richMenuId: id }) })
        : await lineApi(env, '/v2/bot/richmenu/alias', { method: 'POST', type: 'application/json', body: JSON.stringify({ richMenuAliasId: m.alias, richMenuId: id }) });
      if (!al.ok) return json({ error: `設定 ${key} 別名失敗：` + await al.text() }, 502);
      if (key === 'guest') await lineApi(env, '/v2/bot/user/all/richmenu/' + id, { method: 'POST' });
      if (oldId && oldId !== id) await lineApi(env, '/v2/bot/richmenu/' + oldId, { method: 'DELETE' });
      out[key] = id;
    }
    return json({ ok: true, menus: out });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, e && e.code || 500);
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
