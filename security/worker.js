// 白沙屯醫護團｜LINE → Firebase 登入驗證（Cloudflare Worker）
// 收到 LIFF 的 access token → 向 LINE 確認是本頻道、取得 userId → 簽發 Firebase 自訂權杖
// 需要的密鑰（Settings → Variables and Secrets → 類型選 Secret）：
//   SERVICE_ACCOUNT = Firebase 服務帳戶 JSON 檔「整個內容」
// AI 智慧貼上（/parse，只有管理員能用）需要：Settings → Bindings → Workers AI，名稱 AI
// LINE 圖文選單（/menu、/menu-setup）需要 Secret：LINE_BOT_TOKEN = 官方帳號 Messaging API 的 Channel access token（長期）
// LINE 訊息自動回覆（/webhook）需要 Secret：LINE_CHANNEL_SECRET = 官方帳號 Messaging API 頻道的 Channel secret（Basic settings 裡）

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
    { const m = new URL(req.url).pathname.match(/^\/j\/([A-Za-z0-9_-]{6,40})\.jpg$/); if (m && req.method === 'GET') return journeyImg(m[1], env, req); }
    if (new URL(req.url).pathname === '/validate' && req.method === 'GET') {   // 檢查每個自動回覆的格式（LINE 官方驗證）
      const out = {};
      for (const [k, make] of Object.entries(REPLIES)) {
        const r = await fetch('https://api.line.me/v2/bot/message/validate/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
          body: JSON.stringify({ messages: [await make(env, new URL(req.url).origin)] }) });
        out[k] = r.ok ? 'ok' : await r.text();
      }
      return json(out);
    }
    if (new URL(req.url).pathname === '/journey-list' && req.method === 'GET') {
      try { const ps = (await fsList(await saToken(env), 'journey')).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map(p => ({ id: p.id, caption: p.caption || '' }));
        return new Response(JSON.stringify({ photos: ps }), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } }); }
      catch (e) { return json({ error: 'failed' }, 500); }
    }
    if (req.method !== 'POST') return json({ ok: true, service: 'bst-auth', configured: !!env.SERVICE_ACCOUNT, ai: !!env.AI, lineBot: !!env.LINE_BOT_TOKEN, webhook: !!env.LINE_CHANNEL_SECRET });
    const path = new URL(req.url).pathname;
    if (path === '/webhook') return webhookRoute(req, env);
    if (path === '/lot') return lotRoute(req, env, json);
    if (path === '/mysched') return mySchedRoute(req, env, json);
    if (path === '/parse') return parseRoute(req, env, json);
    if (path === '/menu') return menuRoute(req, env, json);
    if (path === '/menu-setup') return menuSetupRoute(req, env, json);
    if (path === '/journey') return journeyRoute(req, env, json);

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
// 三張選單都是 LINE 標準大尺寸 2500×1686（非標準高度在手機上會被壓扁）
// 團員兩頁上方 286px 是分頁列（左 團員專區、右 一般資訊）；一般民眾上方是標題列（整張卡都可按）；下面一排三張直卡
const MW = 2500, MH = 1686, TAB = 286;
const grid3 = (acts, top) => acts.map((a, i) => {
  const cw = Math.floor(MW / 3), x = i * cw;
  return { bounds: { x, y: top, width: i === 2 ? MW - x : cw, height: MH - top }, action: a };
});
const tabs = () => [
  { bounds: { x: 0, y: 0, width: MW / 2, height: TAB }, action: { type: 'richmenuswitch', richMenuAliasId: 'bst-member', data: 'tab=member' } },
  { bounds: { x: MW / 2, y: 0, width: MW / 2, height: TAB }, action: { type: 'richmenuswitch', richMenuAliasId: 'bst-member-b', data: 'tab=public' } },
];
// 一般民眾也看得到的三格：按下去會在聊天室送出這句話，內容請在 LINE 官方帳號後台設定「關鍵字自動回應」
const PUBLIC = [
  { type: 'message', label: '認識醫護團', text: '認識醫護團' },
  { type: 'message', label: '衛教須知', text: '衛教須知' },
  { type: 'message', label: '醫護足跡', text: '醫護足跡' },
];
const MEMBER = [
  { type: 'uri', label: '會員中心', uri: LIFF('2011820105-x1KU6xLW') },
  { type: 'uri', label: '救護紀錄表', uri: LIFF('2011820105-6oXAxIEi') },
  { type: 'uri', label: '倉儲管理', uri: LIFF('2011820105-ofRs4ehy') },
];
const MENUS = {
  guest:   { alias: 'bst-guest',    name: '白沙屯醫護團｜一般民眾', img: 'guest.jpg',   h: MH, areas: grid3(PUBLIC, 0) },
  member:  { alias: 'bst-member',   name: '白沙屯醫護團｜團員專區', img: 'member.jpg',  h: MH, areas: [...tabs(), ...grid3(MEMBER, TAB)] },
  member2: { alias: 'bst-member-b', name: '白沙屯醫護團｜一般資訊', img: 'member2.jpg', h: MH, areas: [...tabs(), ...grid3(PUBLIC, TAB)] },
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

// 建立／更新兩個選單（只有最高管理員）：上傳 SITE/richmenu/ 的圖片（LINE 限 1MB 以內），訪客選單設為預設
async function menuSetupRoute(req, env, json) {
  try {
    if (!env.LINE_BOT_TOKEN) return json({ error: 'LINE_BOT_TOKEN 尚未設定' }, 501);
    const { idToken } = await req.json();
    const meDoc = await fsUser(idToken, uidOfToken(idToken));
    if (!meDoc || meDoc.status !== 'approved' || meDoc.role !== 'admin') return json({ error: 'admin only' }, 403);
    // 1) 先把三個選單都建好、上傳圖片
    const made = {};
    for (const [key, m] of Object.entries(MENUS)) {
      const body = { size: { width: MW, height: m.h }, selected: true, name: m.name, chatBarText: '選單', areas: m.areas };
      const c = await lineApi(env, '/v2/bot/richmenu', { method: 'POST', type: 'application/json', body: JSON.stringify(body) });
      if (!c.ok) return json({ error: `建立 ${key} 失敗：` + await c.text() }, 502);
      const id = (await c.json()).richMenuId;
      const img = await fetch(`${SITE}/richmenu/${m.img}?v=${Date.now()}`);
      if (!img.ok) return json({ error: `讀不到 ${m.img}` }, 502);
      const up = await lineApi(env, `/v2/bot/richmenu/${id}/content`, { method: 'POST', data: true, type: m.img.endsWith('.jpg') ? 'image/jpeg' : 'image/png', body: await img.arrayBuffer() });
      if (!up.ok) return json({ error: `上傳 ${key} 圖片失敗：` + await up.text() }, 502);
      made[key] = id;
    }
    // 2) 別名指到新選單（分頁切換靠別名），訪客選單設為預設，最後刪掉舊選單
    const out = {}, olds = [];
    for (const [key, m] of Object.entries(MENUS)) {
      const id = made[key];
      const old = await lineApi(env, '/v2/bot/richmenu/alias/' + m.alias);
      const oldId = old.ok ? (await old.json()).richMenuId : null;
      const al = oldId
        ? await lineApi(env, '/v2/bot/richmenu/alias/' + m.alias, { method: 'POST', type: 'application/json', body: JSON.stringify({ richMenuId: id }) })
        : await lineApi(env, '/v2/bot/richmenu/alias', { method: 'POST', type: 'application/json', body: JSON.stringify({ richMenuAliasId: m.alias, richMenuId: id }) });
      if (!al.ok) return json({ error: `設定 ${key} 別名失敗：` + await al.text() }, 502);
      if (oldId && oldId !== id) olds.push(oldId);
      out[key] = id;
    }
    await lineApi(env, '/v2/bot/user/all/richmenu/' + made.guest, { method: 'POST' });
    for (const id of olds) await lineApi(env, '/v2/bot/richmenu/' + id, { method: 'DELETE' });
    return json({ ok: true, menus: out });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, e && e.code || 500);
  }
}

// ===== LINE 訊息自動回覆（Webhook）=====
// 官方帳號收到訊息 → LINE 呼叫這裡 → 認得的關鍵字就回卡片；其他訊息不回（交給官方帳號後台的自動回應／真人回覆）
const FB_URL = 'https://www.facebook.com/tszshinems/';
const IG_URL = 'https://www.instagram.com/tszshinems/';
// 前面有圖示的按鈕（Flex 內建按鈕不能放圖示，改用 box 做）
const iconBtn = (icon, label, color, uri) => ({
  type: 'box', layout: 'horizontal', ...(typeof color === 'string' ? { backgroundColor: color } : { background: color }), cornerRadius: '12px', height: '50px',
  justifyContent: 'center', alignItems: 'center', spacing: 'md', action: { type: 'uri', label, uri },
  contents: [
    { type: 'image', url: `${SITE}/richmenu/${icon}?v=7`, size: '30px', aspectRatio: '1:1', flex: 0 },
    { type: 'text', text: label, color: '#ffffff', weight: 'bold', size: 'md', flex: 0 },
  ],
});

// ===== 衛教須知：進香常見狀況（左右滑的卡片）=====
const eduSec = (_icon, title, color, items) => ({
  type: 'box', layout: 'vertical', margin: 'xl', spacing: 'sm', contents: [
    { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [
      { type: 'box', layout: 'vertical', width: '4px', height: '16px', cornerRadius: '2px', backgroundColor: color, contents: [] },
      { type: 'text', text: title, weight: 'bold', size: 'md', color: '#111827', flex: 1 },
    ] },
    ...items.map(t => ({ type: 'box', layout: 'horizontal', spacing: 'md', paddingStart: '2px', contents: [
      { type: 'box', layout: 'vertical', width: '6px', height: '6px', cornerRadius: '3px', backgroundColor: color, offsetTop: '8px', contents: [] },
      { type: 'text', text: t, size: 'sm', color: '#374151', wrap: true, flex: 1, lineSpacing: '4px' },
    ] })),
  ],
});
const eduCard = ({ img, secs, warn }) => ({
  type: 'bubble', size: 'mega',
  hero: { type: 'image', url: `${SITE}/richmenu/edu-${img}.jpg?v=1`, size: 'full', aspectRatio: '15:7', aspectMode: 'cover' },
  body: { type: 'box', layout: 'vertical', paddingAll: '18px', paddingTop: '4px', contents: [
    ...secs.map(x => eduSec(...x)),
    ...(warn ? [{ type: 'box', layout: 'horizontal', margin: 'xl', cornerRadius: '8px', backgroundColor: '#FEF2F2', contents: [
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: '#DC2626', contents: [] },
      { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'xs', flex: 1, contents: [
        { type: 'text', text: '緊急狀況', size: 'xs', color: '#DC2626', weight: 'bold' },
        { type: 'text', text: warn, size: 'sm', color: '#7F1D1D', wrap: true } ] },
    ] }] : []),
  ] },
});
const EDU = [
  { emoji: '🥵', tag: 'HEAT ILLNESS', img: 'heat', title: '中暑・熱衰竭', sub: '白天走在大太陽下最常見', c1: '#F97316', c2: '#DC2626',
    secs: [
      ['⚠️', '注意這些徵兆', '#DC2626', ['頭暈、頭痛、噁心想吐', '大量流汗、全身無力、臉色蒼白', '中暑：體溫很高、皮膚又乾又燙、意識不清']],
      ['✅', '馬上這樣做', '#15803D', ['移到陰涼通風處，躺下、抬高雙腳', '鬆開衣物，用濕毛巾擦身體、搧風', '冰敷脖子、腋下、大腿根部', '意識清楚才小口喝水或運動飲料']],
      ['🛡️', '預防', '#2563EB', ['戴帽子、穿淺色排汗衣', '少量多次喝水，不要等口渴', '中午最熱時多找陰涼處休息']],
    ], warn: '意識不清、叫不太醒、抽搐：立刻撥 119，並找身邊醫護團；不要灌水' },
  { emoji: '🦶', tag: 'BLISTERS', img: 'blister', title: '腳底水泡', sub: '長時間走路，腳是最辛苦的', c1: '#F59E0B', c2: '#EA580C',
    secs: [
      ['🛡️', '預防最重要', '#2563EB', ['穿已經穿習慣、合腳的鞋，不要穿新鞋', '穿排汗襪，多帶幾雙替換，濕了就換', '容易磨的地方先貼人工皮或抹凡士林', '一覺得「熱熱刺刺」就先停下來處理']],
      ['✅', '起水泡了怎麼辦', '#15803D', ['水泡不要自己弄破，貼人工皮保護', '水泡很大或很痛：考慮先休息，減少走路摩擦', '破掉了：清水沖乾淨，表皮不要撕掉，再覆蓋保護']],
    ], warn: '紅、腫、熱、痛越來越嚴重或流膿，可能是感染了，請找醫護團或就醫' },
  { emoji: '💪', tag: 'MUSCLE CRAMPS', img: 'cramp', title: '抽筋', sub: '小腿最常抽，多半是累了或缺電解質', c1: '#8B5CF6', c2: '#6D28D9',
    secs: [
      ['✅', '馬上這樣做', '#15803D', ['停下來，找地方坐下', '小腿抽筋：腳伸直，把腳尖慢慢往身體方向扳', '輕輕按摩，等放鬆了再慢慢走', '補充運動飲料或加鹽的水']],
      ['🛡️', '預防', '#2563EB', ['出發前、休息後先伸展', '流很多汗時，喝水也要補一點鹽分', '累了就休息，不要硬撐']],
    ] },
  { emoji: '☀️', tag: 'SUNBURN', img: 'sunburn', title: '曬傷', sub: '連續好幾天曝曬，皮膚會受不了', c1: '#FBBF24', c2: '#F97316',
    secs: [
      ['🛡️', '預防', '#2563EB', ['擦防曬，流汗後 2 小時補擦一次', '戴寬邊帽、穿袖套或薄長袖', '脖子後面、耳朵、腳背也別忘了']],
      ['✅', '曬傷了怎麼辦', '#15803D', ['用冷水或冷毛巾冷敷降溫', '擦蘆薈膠或保濕乳液', '多喝水，起水泡不要弄破']],
    ] },
  { emoji: '🩹', tag: 'SPRAINS & SCRAPES', img: 'sprain', title: '扭傷・擦傷', sub: '人多、天暗、路不平，走路要小心', c1: '#14B8A6', c2: '#0F766E',
    secs: [
      ['✅', '扭傷', '#15803D', ['先休息，不要再走', '冰敷 15～20 分鐘，用彈性繃帶包紮', '坐下或躺下時把腳抬高']],
      ['✅', '擦傷', '#15803D', ['用乾淨的水把沙子、髒東西沖掉', '用乾淨紗布或 OK 繃蓋住']],
    ], warn: '腳不能踩地、明顯變形或傷口很深流血不止，請找醫護團或撥 119' },
  { emoji: '🚑', tag: 'NEED HELP', img: 'help', title: '需要幫忙時', sub: '白沙屯拱天宮醫護團隨香服務', c1: '#D65A68', c2: '#B4232F',
    secs: [
      ['📍', '找醫護團', '#B4232F', ['找穿醫護團背心的志工', '隊伍前後都有救護人員跟著', '覺得不舒服就說，不要硬撐']],
      ['☎️', '緊急狀況', '#B4232F', ['昏倒、胸痛、呼吸困難、叫不醒', '立刻撥 119，並告訴對方在哪個路口或明顯地標']],
    ] },
];
const REPLIES = {
  '醫護足跡': async (env, origin) => {
    let photos = [];
    try { photos = (await fsList(await saToken(env), 'journey')).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)); } catch (e) {}
    const GALLERY = SITE + '/journey/';
    const img = (p, ratio) => ({ type: 'image', url: `${origin}/j/${p.id}.jpg`, size: 'full', aspectRatio: ratio, aspectMode: 'cover',
      action: { type: 'uri', label: '看照片', uri: `${GALLERY}#${p.id}` } });
    const small = photos.slice(1, 7), extra = photos.length - 7;
    const cell = (p, i) => !p ? { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#F3EFED', contents: [] }
      : (i === 5 && extra > 0) ? { type: 'box', layout: 'vertical', flex: 1, action: { type: 'uri', label: '看全部', uri: GALLERY }, contents: [
          img(p, '1:1'),
          { type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '0px', offsetBottom: '0px', offsetStart: '0px', offsetEnd: '0px',
            backgroundColor: '#00000080', justifyContent: 'center', alignItems: 'center', contents: [
              { type: 'text', text: `+${extra}`, color: '#ffffff', size: 'xxl', weight: 'bold', align: 'center' } ] } ] }
      : { type: 'box', layout: 'vertical', flex: 1, contents: [img(p, '1:1')] };
    const rows = small.length ? [0, 3].filter(k => k === 0 || small.length > 3).map(k => ({ type: 'box', layout: 'horizontal', spacing: '3px',
      contents: [0, 1, 2].map(j => cell(small[k + j], k + j)) })) : [];
    return {
      type: 'flex', altText: '醫護足跡：一路隨香的精彩照片',
      contents: {
        type: 'bubble', size: 'giga',
        ...(photos.length ? { hero: { type: 'box', layout: 'vertical', spacing: '3px', paddingAll: '0px', contents: [
          { type: 'box', layout: 'vertical', contents: [img(photos[0], '16:10')] }, ...rows ] } } : {}),
        body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
          { type: 'text', text: 'OUR JOURNEY', size: 'xs', color: '#C4622E', weight: 'bold' },
          { type: 'box', layout: 'baseline', margin: 'sm', contents: [
            { type: 'text', text: '醫護足跡', weight: 'bold', size: 'xxl', color: '#1f2430', flex: 0 },
            ...(photos.length ? [{ type: 'text', text: `${photos.length} 張照片`, size: 'sm', color: '#9a8f8b', margin: 'md', flex: 0 }] : []) ] },
          { type: 'text', margin: 'md', wrap: true, size: 'sm', color: '#4b5563',
            text: '每一年跟著媽祖一步一腳印，救護、陪伴、守護每一位香燈腳。' },
        ] },
        footer: { type: 'box', layout: 'vertical', paddingAll: '14px', paddingTop: '0px', spacing: 'sm', contents: [
          ...(photos.length ? [{ type: 'button', style: 'primary', color: '#C4622E', height: 'md', action: { type: 'uri', label: '看全部照片', uri: GALLERY } }] : []),
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            iconBtn('ic-fb.png', 'Facebook', '#1877F2', FB_URL + 'photos'),
            iconBtn('ic-ig.png', 'Instagram', { type: 'linearGradient', angle: '90deg', startColor: '#F58529', centerColor: '#DD2A7B', endColor: '#8134AF' }, IG_URL) ] },
        ] },
      },
    };
  },
  '衛教須知': () => ({
    type: 'flex', altText: '衛教須知：中暑、水泡、抽筋、曬傷、扭傷，往左滑看更多',
    contents: { type: 'carousel', contents: EDU.map(eduCard) },
  }),
  '認識醫護團': () => ({
    type: 'flex', altText: '認識白沙屯慈昕醫護文化協會',
    contents: {
      type: 'bubble', size: 'giga',
      hero: { type: 'image', url: SITE + '/richmenu/about-banner.jpg', size: 'full', aspectRatio: '1179:422', aspectMode: 'cover',
              action: { type: 'uri', label: 'Facebook', uri: FB_URL } },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '18px', contents: [
        { type: 'text', text: '白沙屯慈昕醫護文化協會', weight: 'bold', size: 'lg', color: '#1f2430', wrap: true },
        { type: 'text', text: '聖容慈悲心　佑民護萬年', size: 'sm', color: '#B68D40', weight: 'bold' },
        { type: 'separator', margin: 'md' },
        { type: 'text', margin: 'md', wrap: true, size: 'sm', color: '#4b5563',
          text: '我們是白沙屯媽祖進香的醫護志工團隊，一路隨香提供救護、衛教與 CPR／AED 推廣。想多認識我們，歡迎追蹤我們的 Facebook 和 Instagram！' },
      ] },
      footer: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm', contents: [
        iconBtn('ic-fb.png', 'Facebook 粉絲專頁', '#1877F2', FB_URL),
        iconBtn('ic-ig.png', 'Instagram', { type: 'linearGradient', angle: '90deg', startColor: '#F58529', centerColor: '#DD2A7B', endColor: '#8134AF' }, IG_URL),
      ] },
    },
  }),
};
async function webhookRoute(req, env) {
  const ok = () => new Response('ok');
  if (req.method !== 'POST' || !env.LINE_CHANNEL_SECRET || !env.LINE_BOT_TOKEN) return ok();
  const body = await req.text();
  // 確認真的是 LINE 送來的（簽章）
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  if (sig !== req.headers.get('x-line-signature')) return new Response('bad signature', { status: 401 });
  let events = [];
  try { events = JSON.parse(body).events || []; } catch (e) { return ok(); }
  for (const ev of events) {
    if (ev.type !== 'message' || ev.message?.type !== 'text' || !ev.replyToken) continue;
    const t0 = String(ev.message.text).trim(), make = REPLIES[t0 === '認識醫療團' ? '認識醫護團' : t0];   // 舊選單的文字也接受
    if (!make) continue;
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
      body: JSON.stringify({ replyToken: ev.replyToken, messages: [await make(env, new URL(req.url).origin)] }),
    });
  }
  return ok();
}

// ===== 出席調查：團員自己抽籤（前／中／後）=====
// 由伺服器亂數，名額照「每組平分、多的放後面」；用服務帳戶讀寫 Firestore（團員看不到別人的資料）
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
let saTok = null;
async function saToken(env) {
  if (saTok && saTok.exp > Date.now() + 60000) return saTok.t;
  const sa = JSON.parse(env.SERVICE_ACCOUNT), now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt(sa, { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt });
  const j = await r.json(); if (!j.access_token) throw new Error('service token failed');
  saTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return saTok.t;
}
const fv = v => v == null ? null : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? +v.integerValue
  : 'doubleValue' in v ? v.doubleValue : 'timestampValue' in v ? Date.parse(v.timestampValue) : 'nullValue' in v ? null
  : 'mapValue' in v ? fobj(v.mapValue.fields || {}) : 'arrayValue' in v ? (v.arrayValue.values || []).map(fv) : null;
const fobj = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fv(v)]));
const tv = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(Math.round(v)) }
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(tv) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tv(x)])) } };
async function fsGet(tok, path) { const r = await fetch(`${FS}/${path}`, { headers: { Authorization: 'Bearer ' + tok } }); if (r.status === 404) return null; if (!r.ok) throw new Error('read ' + path + ' ' + r.status); return r.json(); }
async function fsList(tok, path) {
  let out = [], pt = '';
  do { const r = await fetch(`${FS}/${path}?pageSize=300${pt ? '&pageToken=' + pt : ''}`, { headers: { Authorization: 'Bearer ' + tok } });
       if (!r.ok) throw new Error('list ' + path); const j = await r.json(); out = out.concat(j.documents || []); pt = j.nextPageToken || ''; } while (pt);
  return out.map(d => ({ id: d.name.split('/').pop(), ...fobj(d.fields) }));
}
const normName = s => String(s || '').replace(/[\s　]+/g, '');
const SLOTS = ['前', '中', '後'];
const slotTargets = n => { const b = Math.floor(n / 3), m = n % 3; return { 前: b, 中: b + (m >= 2 ? 1 : 0), 後: b + (m >= 1 ? 1 : 0) }; };
function groupOf(ro) {     // 要跟會員中心的 groupOf 一樣
  if (!ro) return '未對應名冊';
  const pos = ro.position || '團員', c = String(ro.cert || '').toUpperCase().replace(/[-\s]/g, '');
  if (['團長', '秘書長', '教官團', '顧問'].includes(pos)) return '教官及長官';
  if (['指揮官', '車輛組', '機車組'].includes(pos)) return '指揮官及汽機車組';
  if (c.includes('護理') || c.includes('醫師')) return '護理師';
  if (c.includes('EMTP') || c.includes('EMT2')) return 'EMTP、EMT2';
  if (c.includes('EMT1')) return 'EMT1';
  return '專業人員及志工';
}
async function lotRoute(req, env, json) {
  try {
    const { idToken, eid, action } = await req.json();
    if (!idToken || !eid || !/^[A-Za-z0-9_-]{1,64}$/.test(eid)) return json({ error: 'missing' }, 400);
    // 用本人的權杖讀自己的會員資料 → 確認身分（權杖假的話 Firestore 會拒絕）
    const uid = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).user_id;
    const me = await fetch(`${FS}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } });
    if (!me.ok) return json({ error: 'not signed in' }, 401);
    const u = fobj((await me.json()).fields);
    if (u.status !== 'approved' || !u.rosterId) return json({ state: 'unbound' });
    const tok = await saToken(env);
    const ev = await fsGet(tok, `events/${eid}`); if (!ev) return json({ error: 'no event' }, 404);
    const e = fobj(ev.fields);
    const roster = await fsList(tok, 'member_roster');
    const meRo = roster.find(x => x.id === u.rosterId); if (!meRo) return json({ state: 'unbound' });
    const myKey = normName(meRo.name);
    for (let tries = 0; tries < 5; tries++) {
      const drawDoc = await fsGet(tok, `events/${eid}/admin/draw`);
      const d = drawDoc ? fobj(drawDoc.fields) : {};
      const map = d.map || {}, by = d.by2 || {}, over = d.groupOverride || {};
      // 出席名單（同一人以最後一次為準）
      const latest = {};
      (await fsList(tok, `events/${eid}/responses`)).forEach(x => { const k = normName(x.name); if (k && (!latest[k] || (x.createdAt || 0) >= (latest[k].createdAt || 0))) latest[k] = x; });
      const mine = latest[myKey];
      if (!mine || !['yes', 'join'].includes(mine.attend)) return json({ state: 'noreply', name: meRo.name });
      const byName = {}; roster.forEach(x => { const k = normName(x.name); if (!byName[k]) byName[k] = x; });
      const gOf = k => over[k] || groupOf(byName[k] || null);
      const myG = gOf(myKey);
      if (SLOTS.includes(map[myKey])) return json({ state: 'done', slot: map[myKey], group: myG, name: meRo.name, selfDraw: !!e.selfDraw });
      if (action !== 'draw' || !e.selfDraw) return json({ state: 'ready', group: myG, name: meRo.name, selfDraw: !!e.selfDraw });
      const members = Object.keys(latest).filter(k => ['yes', 'join'].includes(latest[k].attend) && gOf(k) === myG);
      const tg = slotTargets(members.length), left = {};
      SLOTS.forEach(sl => left[sl] = Math.max(0, tg[sl] - members.filter(k => map[k] === sl).length));
      const bag = []; SLOTS.forEach(sl => { for (let i = 0; i < left[sl]; i++) bag.push(sl); });
      const rnd = new Uint32Array(1); crypto.getRandomValues(rnd);
      const slot = bag.length ? bag[rnd[0] % bag.length] : SLOTS[rnd[0] % 3];
      const nd = { ...d, map: { ...map, [myKey]: slot }, by2: { ...by, [myKey]: 'self' }, at: Date.now() };
      // 有人同時抽 → 用版本號避免互相覆蓋，衝突就重來
      const pre = drawDoc ? `&currentDocument.updateTime=${encodeURIComponent(drawDoc.updateTime)}` : '&currentDocument.exists=false';
      const w = await fetch(`${FS}/events/${eid}/admin/draw?updateMask.fieldPaths=map&updateMask.fieldPaths=by2&updateMask.fieldPaths=at${pre}`, {
        method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { map: tv(nd.map), by2: tv(nd.by2), at: { timestampValue: new Date().toISOString() } } }) });
      if (w.ok) return json({ state: 'done', slot, group: myG, name: meRo.name, fresh: true, selfDraw: true });
      if (w.status !== 400 && w.status !== 409 && w.status !== 412) return json({ error: 'write failed ' + w.status }, 500);
    }
    return json({ error: '太多人同時抽，請再試一次' }, 409);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
// ===== 醫護足跡照片：會員中心管理員上傳，LINE 點「醫護足跡」輪播 =====
// journey/{id}：{ caption, order, at }；journey_img/{id}：{ data: JPEG base64 }（用服務帳戶讀寫，不用改資料庫規則）
async function journeyImg(id, env, req) {
  try {
    const cache = caches.default, hit = req && await cache.match(req); if (hit) return hit;
    const d = await fsGet(await saToken(env), `journey_img/${id}`);
    if (!d) return new Response('not found', { status: 404 });
    const b = atob(fobj(d.fields).data || ''); const u8 = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
    const res = new Response(u8, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
    if (req) await cache.put(req, res.clone());
    return res;
  } catch (e) { return new Response('error', { status: 500 }); }
}
async function journeyRoute(req, env, json) {
  try {
    const body = await req.json(), { idToken, action } = body;
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    if (!memberAdmin(me)) return json({ error: '只有會員中心管理員可以管理照片' }, 403);
    const tok = await saToken(env), H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const list = async () => (await fsList(tok, 'journey')).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    const patch = (path, fields) => fetch(`${FS}/${path}?${Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&')}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, tv(v)])) }) });
    if (action === 'list') return json({ ok: true, photos: await list() });
    if (action === 'add') {
      const data = String(body.data || '');
      if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 1000000) return json({ error: '照片太大或格式不對' }, 400);
      const cur = await list(); if (cur.length >= 200) return json({ error: '最多 200 張，請先刪掉一些' }, 400);
      const rnd = new Uint8Array(9); crypto.getRandomValues(rnd); const id = b64url(rnd);
      const w1 = await patch(`journey_img/${id}`, { data }); if (!w1.ok) return json({ error: 'save failed ' + w1.status }, 500);
      const order = cur.length ? Math.max(...cur.map(x => x.order ?? 0)) + 1 : 0;
      await patch(`journey/${id}`, { caption: String(body.caption || '').slice(0, 60), order, at: Date.now() });
      return json({ ok: true, id });
    }
    const id = String(body.id || ''); 
    if (action === 'del') {
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return json({ error: 'bad id' }, 400);
      await fetch(`${FS}/journey/${id}`, { method: 'DELETE', headers: H }); await fetch(`${FS}/journey_img/${id}`, { method: 'DELETE', headers: H });
      return json({ ok: true });
    }
    if (action === 'caption') { await patch(`journey/${id}`, { caption: String(body.caption || '').slice(0, 60) }); return json({ ok: true }); }
    if (action === 'order') {
      const ids = (body.ids || []).filter(x => /^[A-Za-z0-9_-]{6,40}$/.test(x)).slice(0, 60);
      await Promise.all(ids.map((x, i) => patch(`journey/${x}`, { order: i })));
      return json({ ok: true });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code || 500); }
}
// ===== 會員中心：我的排班（管理員在排班表打開「公開給團員看」才會回傳）=====
async function mySchedRoute(req, env, json) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken);
    const me = await fetch(`${FS}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } });
    if (!me.ok) return json({ error: 'not signed in' }, 401);
    const u = fobj((await me.json()).fields);
    if (u.status !== 'approved' || !u.rosterId) return json({ events: [] });
    const tok = await saToken(env);
    const ro = await fsGet(tok, `member_roster/${encodeURIComponent(u.rosterId)}`); if (!ro) return json({ events: [] });
    const myKey = normName(fobj(ro.fields).name);
    const evs = (await fsList(tok, 'events')).filter(e => e.schedPublic);
    const roster = evs.length ? await fsList(tok, 'member_roster') : [], byName = {};
    roster.forEach(x => { const k = normName(x.name); if (k && !byName[k]) byName[k] = x; });
    const catOf = k => { const c = String((byName[k] || {}).cert || '').toUpperCase().replace(/[-\s]/g, ''); return c.includes('護理') || c.includes('醫師') ? 'N' : c.includes('EMTP') || c.includes('EMT2') ? 'T2' : c.includes('EMT1') ? 'T1' : 'O'; };
    const EQN = { kit: '救護包', ambu: 'AMBU包', inst: '儀器包' };
    const out = [];
    for (const e of evs) {
      const dr = await fsGet(tok, `events/${e.id}/admin/draw`); if (!dr) continue;
      const sc = fobj(dr.fields).sched || {}, days = sc.days || {}, info = sc.info || {};
      const latest = {}; (await fsList(tok, `events/${e.id}/responses`)).forEach(x => { const k = normName(x.name); if (k && (!latest[k] || (x.createdAt || 0) >= (latest[k].createdAt || 0))) latest[k] = x; });
      const cmd = Object.keys(latest).filter(k => ['yes', 'join'].includes(latest[k].attend) && (byName[k] || {}).position === '指揮官');
      const eqOf = t => t.eq ? [Object.entries(EQN).filter(([k]) => t.eq[k] > 0).map(([k, n]) => n + '*' + t.eq[k]).join('、'), (t.eq.text || '').trim()].filter(Boolean).join('　') : (t.note || '');
      const LO = l => (String(l).startsWith('轎前') ? -(+String(l).slice(2)) : 10 + (+String(l).slice(2)));
      const cats = {};
      const full = d => (days[d] || []).slice().sort((a, b) => LO(a.l) - LO(b.l)).map(t => { (t.m || []).forEach(k => cats[k] = catOf(k)); return { l: t.l, m: t.m || [], eq: eqOf(t), pn: t.pn || {} }; });
      const mine = Object.keys(days).sort().map(d => {
        const t = (days[d] || []).find(x => (x.m || []).includes(myKey)); if (!t) return null;
        const eq = t.eq ? [Object.entries(EQN).filter(([k]) => t.eq[k] > 0).map(([k, n]) => n + '*' + t.eq[k]).join('、'), (t.eq.text || '').trim()].filter(Boolean).join('　') : (t.note || '');
        const I = info[d] || {}, duty = [];
        [['bus', '中巴值日'], ['stay', '住宿值日'], ['stock', '物資車盤點'], ['wash', '洗衣服']].forEach(([k, n]) => { if (String(I[k] || '').split(/[、,，\s]+/).map(normName).includes(myKey)) duty.push(n); });
        const arrive = String(I.arrive || '').includes(myKey) ? I.arrive : '';
        return { d, tag: I.tag || '', place: I.place || '', team: t.l, members: t.m, eq, note: (t.pn || {})[myKey] || '', duty, arrive,
          teams: full(d), info: { bus: I.bus || '', stay: I.stay || '', stock: I.stock || '', wash: I.wash || '', arrive: I.arrive || '' } };
      }).filter(Boolean);
      out.push({ id: e.id, title: e.title || '', name: myKey, days: mine, cats, cmd });
    }
    return json({ events: out });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
async function signJwt(sa, payload) {
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc(payload);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return data + '.' + b64url(new Uint8Array(sig));
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
