// 白沙屯拱天宮醫護團｜LINE → Firebase 登入驗證（Cloudflare Worker）
// 收到 LIFF 的 access token → 向 LINE 確認是本頻道、取得 userId → 簽發 Firebase 自訂權杖
// 需要的密鑰（Settings → Variables and Secrets → 類型選 Secret）：
//   SERVICE_ACCOUNT = Firebase 服務帳戶 JSON 檔「整個內容」
// AI 智慧貼上（/parse，只有管理員能用）需要：Settings → Bindings → Workers AI，名稱 AI
// LINE 圖文選單（/menu、/menu-setup）需要 Secret：LINE_BOT_TOKEN = 官方帳號 Messaging API 的 Channel access token（長期）
// LINE 訊息自動回覆（/webhook）需要 Secret：LINE_CHANNEL_SECRET = 官方帳號 Messaging API 頻道的 Channel secret（Basic settings 裡）

import { DurableObject } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';

// ===== 用量計數（開發者「使用分析」看哪個功能用最多）=====
// 每台伺服器先記在記憶體，約 1 分鐘合併一次送到 LocHub 存起來（每小時一格，UTC）
// r＝Worker 請求（依路徑）、f＝Firestore 讀取文件數、fw／fd＝寫入／刪除、d＝呼叫 DO 次數（依方法）
const RCTX = new AsyncLocalStorage();
const MTR = { at: Date.now(), b: {} };
const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 13).replace(/[-T]/g, '');
function mAdd(cat, key, n = 1) { const h = hourKey(), b = MTR.b[h] || (MTR.b[h] = {}), c = b[cat] || (b[cat] = {}); c[key] = (c[key] || 0) + n; }
const routeKey = p => /^\/(j|c|gc)\//.test(p) ? p.replace(/^\/(j|c|gc)\/.*/, '/$1/*') : p.slice(0, 40);
function meterFlush(env, ctx, force) {
  if (!env.LOC || !ctx || (!force && Date.now() - MTR.at < 60e3) || !Object.keys(MTR.b).length) return;
  const b = MTR.b; MTR.b = {}; MTR.at = Date.now();
  ctx.waitUntil(env.LOC.get(env.LOC.idFromName('main')).meterAdd(b).catch(() => {}));
}
{ const _fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const res = await _fetch(input, init);
    try { const url = typeof input === 'string' ? input : input.url;
      if (url.includes('firestore.googleapis.com')) {
        const route = RCTX.getStore() || '(背景)', method = ((init && init.method) || 'GET').toUpperCase();
        const cnt = f => res.clone().json().then(j => mAdd('f', route, Math.max(1, f(j)))).catch(() => mAdd('f', route, 1));
        if (/:runQuery$/.test(url)) cnt(j => (Array.isArray(j) ? j : []).filter(x => x.document).length);
        else if (/:batchGet$/.test(url)) cnt(j => (Array.isArray(j) ? j : []).filter(x => x.found).length);
        else if (/:commit$/.test(url)) { let n = 1; try { n = (JSON.parse(init.body).writes || []).length || 1; } catch (e) {} mAdd('fw', route, n); }
        else if (method === 'GET') { if (/[?&]pageSize=/.test(url)) cnt(j => (j.documents || []).length); else mAdd('f', route, 1); }
        else if (method === 'DELETE') mAdd('fd', route, 1);
        else mAdd('fw', route, 1);
      } } catch (e) {}
    return res;
  };
}

const LINE_CHANNEL_ID = '2011820105';
const ALLOWED_ORIGINS = ['https://eurekateamstar-star.github.io'];
// Cloudflare Pages：正式網址 tsushin-buishatun.pages.dev（bst-app-41d、bst-record 為搬家前舊網址）
const PAGES_RE = /^https:\/\/([a-z0-9]+\.)?(tsushin-buishatun|bst-app-41d|bst-record)\.pages\.dev$/;
const originOk = o => ALLOWED_ORIGINS.includes(o) || PAGES_RE.test(o);
const PROJECT_ID = 'linebot-firebase-b1242';
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const WORKER = {
  async fetch(req, env, ctx) {
    const rk = routeKey(new URL(req.url).pathname); mAdd('r', rk);
    try { return await RCTX.run(rk, () => handleReq(req, env, ctx)); }
    finally { meterFlush(env, ctx); }
  },
};
export default WORKER;
async function handleReq(req, env, ctx) {
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
    { const m = new URL(req.url).pathname.match(/^\/c\/([A-Za-z0-9_-]{6,40})\.jpg$/); if (m && req.method === 'GET') return journeyImg(m[1], env, req, 'share_img'); }
    { const m = new URL(req.url).pathname.match(/^\/gc\/([A-Za-z0-9_-]{6,40})\.jpg$/); if (m && req.method === 'GET') return journeyImg(m[1], env, req, 'guardian_img'); }
    if (new URL(req.url).pathname === '/pic' && req.method === 'GET') {   // LINE 大頭貼代理（讓 canvas 可以存圖）
      const u = new URL(req.url).searchParams.get('u') || '';
      let h = ''; try { h = new URL(u).hostname; } catch (e) {}
      if (!/^https:/.test(u) || !/(^|\.)line-scdn\.net$|^i\.ibb\.co$/.test(h)) return new Response('bad url', { status: 400 });
      const r = await fetch(u, { cf: { cacheTtl: 3600 } }); if (!r.ok) return new Response('not found', { status: 404 });
      return new Response(r.body, { headers: { 'Content-Type': r.headers.get('Content-Type') || 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } });
    }
    if (new URL(req.url).pathname === '/body-zones' && req.method === 'GET') {   // 救護紀錄表人體圖的部位輪廓（公開、不含個資）
      try { const d = await fsGet(await saToken(env), 'system_configs/body_map_polygons'); return json({ ok: true, zones: d ? fobj(d.fields).zones || null : null }); }
      catch (e) { return json({ error: 'failed' }, 500); }
    }
    if (/^\/ls\/[A-Za-z0-9]{12}\.jpg$/.test(new URL(req.url).pathname) && req.method === 'GET' && env.LOC) {   // 集結卡片的地圖截圖（6 小時後失效）
      const b = await locHub(env).shareImg(new URL(req.url).pathname.slice(4, 16));
      if (!b) return new Response('expired', { status: 404 });
      return new Response(Uint8Array.from(atob(b), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=21600' } });
    }
    if (new URL(req.url).pathname === '/share-get' && req.method === 'GET') {   // 分享卡片內容（公開，給 LIFF 分享頁用）
      const id = new URL(req.url).searchParams.get('id') || '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return json({ error: 'bad id' }, 400);
      if (id.startsWith('ls_') && env.LOC) {   // 定位分享：分享當下的位置快照
        const v = await locHub(env).shareGet(id.slice(3)); if (!v) return json({ error: '這個分享已經過期了（6 小時）' }, 404);
        const nav = `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}&travelmode=walking`;
        const flex = { type: 'flex', altText: v.title + '：' + v.text, contents: { type: 'bubble', size: 'kilo',
          header: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: v.title.startsWith('🚩') ? '#dc2626' : '#2563eb', contents: [{ type: 'text', text: v.title, weight: 'bold', size: 'lg', color: '#ffffff', wrap: true }] },
          body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
            { type: 'text', text: v.text, wrap: true, weight: 'bold', size: 'md', color: '#111827' },
            { type: 'text', text: v.sub + (v.by ? '・' + v.by + ' 分享' : ''), wrap: true, size: 'xs', color: '#6b7280' } ] },
          footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
            { type: 'button', style: 'primary', color: '#16a34a', action: { type: 'uri', label: '🚶 走路導航過去', uri: nav } },
            { type: 'button', style: 'secondary', action: { type: 'uri', label: '打開定位地圖', uri: 'https://liff.line.me/2011820105-x1KU6xLW?go=locate' } } ] } } };
        if (v.rally && v.img) {   // 樣式 6：正方形大地圖＋上方大字「幾點前」＋團員位置
          const tm = t => new Date(t + 8 * 3600e3).toISOString().slice(11, 16), img = new URL(req.url).origin + '/ls/' + id.slice(3) + '.jpg';
          const big = v.due ? tm(v.due) + ' 前' : '現在集合';
          const f6 = { type: 'flex', altText: '🚩 集結通知：' + v.text + (v.due ? '（' + tm(v.due) + ' 前）' : ''), contents: { type: 'bubble', size: 'giga',
            hero: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [
              { type: 'image', url: img, size: 'full', aspectRatio: '1:1', aspectMode: 'cover', action: { type: 'uri', label: '導航', uri: nav } },
              { type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '0px', offsetStart: '0px', offsetEnd: '0px', backgroundColor: '#A32D2DEE', paddingAll: '10px', contents: [
                { type: 'text', text: '🚩 集結通知', size: 'sm', color: '#FFFFFF', align: 'center' },
                { type: 'text', text: big, size: '3xl', weight: 'bold', color: '#FFFFFF', align: 'center' } ] },
              { type: 'box', layout: 'vertical', position: 'absolute', offsetBottom: '16px', offsetStart: '16px', offsetEnd: '16px', backgroundColor: '#FFFFFFF2', cornerRadius: '12px', paddingAll: '10px', contents: [
                { type: 'text', text: v.text, weight: 'bold', size: 'lg', color: '#2C2C2A', align: 'center', wrap: true },
                { type: 'text', text: `${v.r} 公尺內算到達${v.by ? '・' + v.by + ' 分享' : ''}`, size: 'xs', color: '#5F5E5A', align: 'center', wrap: true } ] } ] },
            footer: { type: 'box', layout: 'horizontal', paddingAll: '10px', spacing: 'sm', contents: [
              { type: 'button', style: 'primary', color: '#3B6D11', height: 'sm', action: { type: 'uri', label: '🚶 走路導航', uri: nav } },
              { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '打開地圖', uri: 'https://liff.line.me/2011820105-x1KU6xLW?go=locate' } } ] } } };
          return new Response(JSON.stringify({ ok: true, card: { id, kind: 'loc', title: v.title, text: v.text + '\n' + (v.due ? tm(v.due) + ' 前到' : ''), imgUrl: img, flex: f6 } }), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        const loc = { type: 'location', title: v.title.replace(/^\S+\s/, '').slice(0, 100), address: v.text.slice(0, 100) || '白沙屯拱天宮醫護團', latitude: v.lat, longitude: v.lon };
        return new Response(JSON.stringify({ ok: true, card: { id, kind: 'loc', title: v.title, text: v.text + '\n' + v.sub, flex, extra: [loc] } }), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      try { let card = EDU_CARDS[id];
        if (!card) { const d = await fsGet(await saToken(env), `share/${id}`); if (!d) return json({ error: '這張卡片已經刪除了' }, 404); card = { id, ...fobj(d.fields) }; }
        return new Response(JSON.stringify({ ok: true, card: { ...card, flex: cardFlex(card, new URL(req.url).origin) } }), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' } }); }
      catch (e) { return json({ error: 'failed' }, 500); }
    }
    if (new URL(req.url).pathname === '/validate' && req.method === 'GET') {   // 檢查每個自動回覆的格式（LINE 官方驗證）
      const out = {};
      for (const [k, make] of Object.entries(REPLIES)) {
        const r = await fetch('https://api.line.me/v2/bot/message/validate/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
          body: JSON.stringify({ messages: [await make(env, new URL(req.url).origin)] }) });
        out[k] = r.ok ? 'ok' : await r.text();
      }
      { const r = await fetch('https://api.line.me/v2/bot/message/validate/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
          body: JSON.stringify({ messages: [shareFlex({ id: 'sample000', title: '標題', text: '說明', w: 1080, h: 1350 }, new URL(req.url).origin), shareFlex(EDU_CARDS['edu-heat'], '')] }) });
        out['分享卡片'] = r.ok ? 'ok' : await r.text(); }
      { const r = await fetch('https://api.line.me/v2/bot/message/validate/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
          body: JSON.stringify({ messages: [eduAllFlex(new URL(req.url).origin)] }) });
        out['衛教一排'] = r.ok ? 'ok' : await r.text(); }
      { const r = await fetch('https://api.line.me/v2/bot/message/validate/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
          body: JSON.stringify({ messages: [noticeFlex({ kind: '用餐登記', sub: '116年白沙屯往北港進香', rows: [['日期', '10/25(日)'], ['項目', '中餐・晚餐']] }, '請登記用餐', '說明文字', '前往登記', 'https://liff.line.me/x')] }) });
        out['通知卡片'] = r.ok ? 'ok' : await r.text(); }
      return json(out);
    }
    if (new URL(req.url).pathname === '/guardian-map' && req.method === 'GET') return guardianMapRoute(req, env, json, ctx);
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
    if (path === '/myplan') return myPlanRoute(req, env, json);
    if (path === '/lead') return leadRoute(req, env, json);
    if (path === '/groups') return groupsRoute(req, env, json);
    if (path === '/groupset') return groupSetRoute(req, env, json);
    if (path === '/mygroup') return myGroupRoute(req, env, json);
    if (path === '/nudge') return nudgeRoute(req, env, json);
    if (path === '/viewsched') return viewSchedRoute(req, env, json);
    if (path === '/remind') return remindRoute(req, env, json);
    if (path === '/parse') return parseRoute(req, env, json);
    if (path === '/menu') return menuRoute(req, env, json);
    if (path === '/gate') return json({ open: await memberGate(env) });
    if (path === '/gate-set') return gateSetRoute(req, env, json);
    if (path === '/menu-setup') return menuSetupRoute(req, env, json);
    if (path === '/journey') return journeyRoute(req, env, json);
    if (path === '/sharecard') return shareCardRoute(req, env, json);
    if (path === '/guardian-no') return guardianNoRoute(req, env, json);
    if (path === '/guardian-img') return guardianImgRoute(req, env, json);
    if (path === '/item-cats') return itemCatsRoute(req, env, json);
    if (path === '/wh-members') return whMembersRoute(req, env, json);
    if (path === '/whtake') return whTakeRoute(req, env, json);
    if (path === '/edu-hit') return eduHitRoute(req, env, json);
    if (path === '/edu-stats') return eduStatsRoute(req, env, json);
    if (path === '/usage') return usageRoute(req, env, json);
    if (path === '/usage-stats') return usageStatsRoute(req, env, json);
    if (path === '/usage-trip') return usageTripRoute(req, env, json);
    if (path === '/usage-quota') return usageQuotaRoute(req, env, json);
    if (path === '/usage-meter') return usageMeterRoute(req, env, json);
    if (path === '/usage-cf') return usageCfRoute(req, env, json);
    if (path === '/usage-line') return usageLineRoute(req, env, json);
    if (path === '/line-check') return lineCheckRoute(req, env, json);
    if (path === '/wh-sched') return whSchedRoute(req, env, json);
    if (path === '/owntracks') return otRoute(req, env);
    if (path === '/loc') return locRoute(req, env, json);
    if (path === '/loc-can') return locCanRoute(req, env, json);
    if (path === '/loc-admin') return locAdminRoute(req, env, json);
    if (path === '/loc-self') return locSelfRoute(req, env, json);
    if (path === '/loc-track') return locTrackRoute(req, env, json);
    if (path === '/loc-rally') return locRallyRoute(req, env, json);
    if (path === '/loc-share') return locShareRoute(req, env, json);

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
}

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
  const n = acts.length, cw = Math.floor(MW / n), x = i * cw;   // 依按鈕數平均切（3 格或 4 格）
  return { bounds: { x, y: top, width: i === n - 1 ? MW - x : cw, height: MH - top }, action: a };
});
const tabs = () => [
  { bounds: { x: 0, y: 0, width: MW / 2, height: TAB }, action: { type: 'richmenuswitch', richMenuAliasId: 'bst-member', data: 'tab=member' } },
  { bounds: { x: MW / 2, y: 0, width: MW / 2, height: TAB }, action: { type: 'richmenuswitch', richMenuAliasId: 'bst-member-b', data: 'tab=public' } },
];
// 一般民眾也看得到的四格：按下去會在聊天室送出這句話，內容請在 LINE 官方帳號後台設定「關鍵字自動回應」
const PUBLIC = [
  { type: 'message', label: '認識醫護團', text: '認識醫護團' },
  { type: 'message', label: '衛教須知', text: '衛教須知' },
  { type: 'message', label: '醫護足跡', text: '醫護足跡' },
  { type: 'message', label: '全民醫護證', text: '全民醫護證' },
];
const MEMBER = [
  { type: 'uri', label: '團員專區', uri: LIFF('2011820105-x1KU6xLW') },
  { type: 'uri', label: '救護紀錄表', uri: LIFF('2011820105-6oXAxIEi') },
  { type: 'uri', label: '倉儲管理', uri: LIFF('2011820105-ofRs4ehy') },
];
const MENUS = {
  guest:   { alias: 'bst-guest',    name: '白沙屯拱天宮醫護團｜一般民眾', img: 'guest.jpg',   h: MH, areas: grid3(PUBLIC, 0) },
  member:  { alias: 'bst-member',   name: '白沙屯拱天宮醫護團｜團員專區', img: 'member.jpg',  h: MH, areas: [...tabs(), ...grid3(MEMBER, TAB)] },
  member2: { alias: 'bst-member-b', name: '白沙屯拱天宮醫護團｜一般資訊', img: 'member2.jpg', h: MH, areas: [...tabs(), ...grid3(PUBLIC, TAB)] },
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
  return { role: v('role'), status: v('status'), adminMember: v('adminMember') === true, adminWarehouse: v('adminWarehouse') === true, warehouseHelper: v('warehouseHelper') === true, warehouseRemoved: v('warehouseRemoved') === true, adminRecord: v('adminRecord') === true, earlyAccess: v('earlyAccess') === true, realName: v('realName') || '' };
}
const memberAdmin = u => !!u && u.status === 'approved' && (u.role === 'admin' || u.adminMember);
// 完整管理員（全部系統）或開發者：可以管理圖文選單、醫護足跡照片、分享卡片、衛教統計、管理員權限
async function fullAdmin(me, idToken, env) { if (!me || me.status !== 'approved') return false; if (me.role === 'admin') return true;
  try { return uidOfToken(idToken) === await devUid(await saToken(env)); } catch (e) { return false; } }

// 依會員狀態切換某人的選單：{ idToken, uid? }，uid 省略＝自己；改別人要團員專區管理員
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
    let kind = u && u.status === 'approved' ? 'member' : 'guest';
    if (kind === 'member' && isRegular(u) && !u.earlyAccess && !(await memberGate(env)) && target !== await devUid(await saToken(env))) kind = 'guest';   // 團員功能關閉中：一般團員先用民眾選單
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
    if (!(await fullAdmin(meDoc, idToken, env))) return json({ error: 'admin only' }, 403);
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
  hero: { type: 'image', url: `${SITE}/richmenu/edu-${img}.jpg?v=2`, size: 'full', aspectRatio: '15:7', aspectMode: 'cover' },
  body: { type: 'box', layout: 'vertical', paddingAll: '18px', paddingTop: '4px', contents: [
    ...secs.map(x => eduSec(...x)),
    ...(warn ? [{ type: 'box', layout: 'horizontal', margin: 'xl', cornerRadius: '8px', backgroundColor: '#FEF2F2', contents: [
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: '#DC2626', contents: [] },
      { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'xs', flex: 1, contents: [
        { type: 'text', text: '緊急狀況', size: 'xs', color: '#DC2626', weight: 'bold' },
        { type: 'text', text: warn, size: 'sm', color: '#7F1D1D', wrap: true } ] },
    ] }] : []),
  ] },
  footer: { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', contents: [
    { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '➦ 一次分享全部衛教小卡', uri: `${SHARE_LIFF}?share=edu-all` } }] },
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
  { emoji: '🚑', tag: 'NEED HELP', img: 'help', title: '需要幫忙時', sub: '白沙屯拱天宮醫護團進香服務', c1: '#D65A68', c2: '#B4232F',
    secs: [
      ['📍', '找醫護團', '#B4232F', ['找穿橘色衣服、醫護團臂章的志工', '隊伍前後都有救護人員跟著', '覺得不舒服就說，不要硬撐']],
      ['☎️', '緊急狀況', '#B4232F', ['昏倒、胸痛、呼吸困難、叫不醒', '立刻撥 119，並告訴對方在哪個路口或明顯地標']],
    ] },
];
const REPLIES = {
  '全民醫護證': () => guardianFlex(),
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
  if (sig !== req.headers.get('x-line-signature')) { mAdd('r', '/webhook 簽章不符'); return new Response('bad signature', { status: 401 }); }   // 會出現在使用分析：通常是 LINE_CHANNEL_SECRET 設錯
  let events = [];
  try { events = JSON.parse(body).events || []; } catch (e) { return ok(); }
  const stat = lineUsage(env, events).catch(() => {});   // 使用分析（不影響回覆）
  for (const ev of events) {
    if (ev.type === 'follow' && ev.replyToken) {   // 新加好友（例如點了親友分享的全民醫護證連結）：直接送上全民醫護證（回覆訊息，免費）
      try { await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
        body: JSON.stringify({ replyToken: ev.replyToken, messages: [tagSrc(await REPLIES['全民醫護證'](env, new URL(req.url).origin), 'follow')] }) }); } catch (e) {}
      continue;
    }
    if (ev.type !== 'message' || ev.message?.type !== 'text' || !ev.replyToken) continue;
    const t0 = String(ev.message.text).trim(), make = REPLIES[t0 === '認識醫療團' ? '認識醫護團' : t0];   // 舊選單的文字也接受
    if (!make) continue;
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
      body: JSON.stringify({ replyToken: ev.replyToken, messages: [tagSrc(await make(env, new URL(req.url).origin), 'menu')] }),
    });
  }
  await stat;
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
// 有開選組：指揮官、車輛組組長、確認在車輛組的人 → 指揮官及汽機車組（要跟團員專區的 carSet 一樣）
function carSetOf(e, fin) {
  if (!e || !e.askGroups) return null;
  const GP = parseGroups(e.groupsText), set = new Set();
  GP.core.filter(c => /指揮官/.test(c.t)).forEach(c => set.add(leadKey(c.n)));
  GP.gs.filter(g => /車/.test(g.n)).forEach(g => { g.lead.forEach(l => set.add(leadKey(l.n))); Object.keys((fin || {})[g.n] || {}).forEach(k => set.add(k)); });
  return set;
}
function groupOf(ro, cs) {     // 要跟團員專區的 groupOf 一樣
  if (!ro) return '未對應名冊';
  const pos = ro.position || '團員', c = String(ro.cert || '').toUpperCase().replace(/[-\s]/g, '');
  if (['團長', '秘書長', '教官團', '顧問'].includes(pos)) return '教官及長官';
  if (cs ? (pos === '指揮官' || cs.has(normName(ro.name))) : ['指揮官', '車輛組', '機車組'].includes(pos)) return '指揮官及汽機車組';
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
    const roster = (await fsList(tok, 'member_roster')).filter(x => !x.left);
    const meRo = roster.find(x => x.id === u.rosterId); if (!meRo) return json({ state: 'unbound' });
    const myKey = normName(meRo.name);
    // 不會變的資料先讀一次（出席名單、選組），迴圈裡只重讀抽籤結果 → 很多人同時抽也很快
    const latest = {};
    (await fsList(tok, `events/${eid}/responses`)).forEach(x => { const k = normName(x.name); if (k && (!latest[k] || (x.createdAt || 0) >= (latest[k].createdAt || 0))) latest[k] = x; });
    const gdoc = e.askGroups ? await fsGet(tok, `events/${eid}/admin/groups`) : null;
    for (let tries = 0; tries < 15; tries++) {
      if (tries) await new Promise(r => setTimeout(r, 40 + Math.random() * 120 * Math.min(tries, 6)));   // 撞到別人 → 隨機等一下再試
      const drawDoc = await fsGet(tok, `events/${eid}/admin/draw`);
      const d = drawDoc ? fobj(drawDoc.fields) : {};
      const map = d.map || {}, by = d.by2 || {}, over = d.groupOverride || {};
      const mine = latest[myKey];
      if (!mine || !['yes', 'join'].includes(mine.attend)) return json({ state: 'noreply', name: meRo.name });
      const byName = {}; roster.forEach(x => { const k = normName(x.name); if (!byName[k]) byName[k] = x; });
      const cs = carSetOf(e, gdoc ? fobj(gdoc.fields).final : {});
      const gOf = k => over[k] || groupOf(byName[k] || null, cs);
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
    return json({ error: '太多人同時抽，請再按一次', busy: true }, 409);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
// ===== 醫護足跡照片：團員專區管理員上傳，LINE 點「醫護足跡」輪播 =====
// journey/{id}：{ caption, order, at }；journey_img/{id}：{ data: JPEG base64 }（用服務帳戶讀寫，不用改資料庫規則）
async function journeyImg(id, env, req, coll = 'journey_img') {
  try {
    const cache = caches.default, hit = req && await cache.match(req); if (hit) return hit;
    const d = await fsGet(await saToken(env), `${coll}/${id}`);
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
    if (!(await fullAdmin(me, idToken, env))) return json({ error: '只有完整管理員可以管理照片' }, 403);
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
const GUARDIAN_URL = 'https://liff.line.me/2011820105-k0FCAoxQ';   // 全民醫護證 LIFF
const SHARE_LIFF = 'https://liff.line.me/2011820105-Is9eno4N', OA_URL = 'https://line.me/R/ti/p/@393geitc';
// 內建衛教小卡（圖在 /richmenu/card-*.jpg，由 scratchpad edu_card.py 產生）
const EDU_H = {};   // 衛教小卡都是 1080×1080 正方形
const EDU_CARDS = Object.fromEntries(EDU.map(e => ['edu-' + e.img, { id: 'edu-' + e.img, builtin: true, w: 1080, h: EDU_H[e.img] || 1080,
  alt: '衛教小卡：' + e.title, imgUrl: `${SITE}/richmenu/card-${e.img}.jpg?v=5` }]));
EDU_CARDS['edu-all'] = { id: 'edu-all', builtin: true, w: 1080, h: 1080, alt: '衛教小卡（6 張，左右滑動）', imgUrl: `${SITE}/richmenu/card-heat.jpg?v=5`,
  title: '衛教小卡・一次分享 6 張', text: '中暑、水泡、抽筋、曬傷、扭傷、求助，收到的人可以左右滑動看完。' };
EDU_CARDS.guardian = { id: 'guardian', builtin: true, w: 1024, h: 756, alt: '全民醫護證｜不用證照，也能守護身邊的人', imgUrl: `${SITE}/richmenu/guardian-promo.jpg?v=3`,
  title: '領一張你的全民醫護證', text: '不用證照，也能守護身邊的人。放上照片、勾選你會的守護技能，做一張屬於你的醫護證！', btn: '🪪 領取我的全民醫護證', url: GUARDIAN_URL };
EDU_CARDS['wh-entry'] = { id: 'wh-entry', builtin: true, w: 1040, h: 1600, alt: '白沙屯拱天宮醫護團｜倉庫管理入口（團員專用）', imgUrl: `${SITE}/richmenu/wh-entry2.jpg?v=1`,
  title: '📦 倉庫管理入口', text: '醫護團團員專用：掃物品 QR 找位置、看腰包裡有什麼、領用歸還一掃就好。', btn: '📦 開啟倉庫管理', url: 'https://liff.line.me/2011820105-ofRs4ehy?scan=1' };
function shareFlex(c, origin) {
  const ratio = Math.min(3, Math.max(1 / 3, (c.w || 1) / (c.h || 1))), W = 1000, H = Math.round(W / ratio);
  const body = [], heroUrl = c.imgUrl || `${origin}/c/${c.id}.jpg`;
  if (c.title) body.push({ type: 'text', text: c.title, weight: 'bold', size: 'lg', color: '#ffffff', wrap: true });
  if (c.text) body.push({ type: 'text', text: c.text, size: 'sm', color: '#ffffffcc', wrap: true, margin: c.title ? 'sm' : 'none', lineSpacing: '4px' });
  body.push({ type: 'box', layout: 'vertical', backgroundColor: '#ffffff', cornerRadius: '10px', paddingAll: '11px', margin: body.length ? 'lg' : 'none',
    action: { type: 'uri', label: '看更多', uri: c.url || OA_URL },
    contents: [{ type: 'text', text: c.btn || '🏥 到白沙屯拱天宮醫護團 LINE 看更多', weight: 'bold', size: 'sm', color: '#1e3a5f', align: 'center', wrap: true }] });
  body.push({ type: 'text', text: '➦ 分享給親友', size: 'sm', color: '#ffffff', align: 'center', margin: 'lg', action: { type: 'uri', label: '分享給親友', uri: `${SHARE_LIFF}?share=${c.id}` } });
  return { type: 'flex', altText: c.alt || c.title || '白沙屯拱天宮醫護團', contents: { type: 'bubble', size: 'mega',
    hero: { type: 'image', url: heroUrl, size: 'full', aspectMode: 'cover', aspectRatio: `${W}:${H}` },
    body: { type: 'box', layout: 'vertical', paddingAll: '13px', backgroundColor: '#1e3a5f', contents: body } } };
}
// ===== 倉庫：用 AI 把物品名稱分成品項類別（結果存在 settings/item_cats，同名只分一次）=====
const ITEM_CATS = ['傷口照護', '檢測儀器', '急救呼吸', '輸液注射', '防護用品', '藥品噴劑', '冰敷保暖', '通訊器材', '照明指揮', '教學器材', '服裝配件', '急救包袋', '後勤用品', '其他'];
const CAT_VER = 2;
// 明確規則先分（比 AI 準）：衣服帽子褲子 → 服裝配件；各種急救包/腰包/背包 → 急救包袋
function ruleCat(n) {
  if (/夾鏈袋|垃圾袋|冰敷袋/.test(n)) return '';
  if (/上衣|衣服|外套|雨衣|褲|帽|背心|毛巾|頭巾|袖套|手套套|臂章|鞋|襪|圍巾|T恤|POLO|polo/.test(n) && !/背心式/.test(n)) return '服裝配件';
  if (/(急救|救護|醫療).*包|包.*(急救|救護)|腰包|背包|擔架包|側背包|醫藥包/.test(n)) return '急救包袋';
  return '';
}
async function itemCatsRoute(req, env, json) {
  try {
    const { idToken, names } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    if (!me || me.status !== 'approved') return json({ error: 'not allowed' }, 403);
    const tok = await saToken(env);
    const cur = await fsGet(tok, 'settings/item_cats'), curObj = cur ? fobj(cur.fields) : {}, map = curObj.map || {};
    let dirty = false;
    if (curObj.ver !== CAT_VER) {   // 類別改版：舊的「後勤用品／其他」重新分
      Object.keys(map).forEach(k => { if (map[k] === '後勤用品' || map[k] === '其他' || !ITEM_CATS.includes(map[k])) delete map[k]; }); dirty = true;
    }
    (names || []).forEach(n => { n = String(n || '').trim().slice(0, 40); const c = n && ruleCat(n); if (c && map[n] !== c) { map[n] = c; dirty = true; } });
    const todo = [...new Set((names || []).map(n => String(n || '').trim().slice(0, 40)).filter(n => n && !map[n]))].slice(0, 150);
    if (todo.length && env.AI) { dirty = true;
      const sys = '你是醫護團倉庫的物品分類助手。請把每個物品名稱歸到最適合的一個類別，類別只能用下列其中之一：' + ITEM_CATS.join('、') + '。\n'
        + '參考：紗布、彈繃、棉枝、敷料、OK繃、碘酒、酒精棉片＝傷口照護；血壓計、血氧機、血糖機、試紙、耳溫槍、瞳孔筆、聽診器＝檢測儀器；'
        + 'AED、OPA、NPA、I Gel、AMBU、氧氣、止血帶、頸圈＝急救呼吸；生理食鹽水 N/S、點滴、注射液、針具＝輸液注射；手套、口罩、隔離衣、垃圾袋＝防護用品；'
        + '軟膏、噴劑、凡士林、藥品＝藥品噴劑；冰敷袋、爆冰包、保暖鋁箔紙、暖暖包＝冰敷保暖；無線電、天線、麥克風、耳麥、充電座＝通訊器材；'
        + '頭燈、肩燈、指揮棒、手電筒、口哨＝照明指揮；安妮、哈姆立克、教學假人＝教學器材；上衣、背心、帽子、褲子、毛巾、雨衣＝服裝配件；'
        + '急救包、急救背包、腰包、救護包、擔架包＝急救包袋；帳篷、桌椅、剪刀、膠帶、夾鏈袋、推車、收納箱＝後勤用品。\n'
        + '回傳 JSON：{"items":[{"name":"原名稱","cat":"類別"}]}，名稱要跟輸入完全一樣。';
      for (let i = 0; i < todo.length; i += 50) {
        const part = todo.slice(i, i + 50);
        try {
          const out = await env.AI.run(AI_MODEL, { messages: [{ role: 'system', content: sys }, { role: 'user', content: part.join('\n') }],
            response_format: { type: 'json_schema', json_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, cat: { type: 'string' } }, required: ['name', 'cat'] } } }, required: ['items'] } },
            max_tokens: 2500, temperature: 0 });
          let data = out && out.response; if (typeof data === 'string') { const m = data.match(/\{[\s\S]*\}/); data = m ? JSON.parse(m[0]) : {}; }
          (data.items || []).forEach(x => { const n = String(x.name || '').trim(); if (part.includes(n)) map[n] = ITEM_CATS.includes(x.cat) ? x.cat : '其他'; });
        } catch (e) {}
      }
    }
    if (dirty) await fetch(`${FS}/settings/item_cats?updateMask.fieldPaths=map&updateMask.fieldPaths=ver`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { ver: { integerValue: String(CAT_VER) }, map: { mapValue: { fields: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { stringValue: v }])) } } } }) });
    return json({ ok: true, cats: ITEM_CATS, map });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// ===== 倉庫進出庫小幫手：只拿可領用成員的名字／分類／頭貼（不含身分證等個資）=====
// ===== 倉庫：團員自己掃物品 QR 接收（在庫 → 領取；在別人手上 → 轉交給自己）=====
// 只改那一件的狀態（直接改 Firestore 原始資料，其他欄位原封不動），並寫一筆進出紀錄
async function whTakeRoute(req, env, json) {
  try {
    const { idToken, code, target } = await req.json();
    if (!idToken || !/^ITEM_[^_]+_\d+_[A-Za-z0-9-]+$/.test(code || '')) return json({ error: '請掃「每一件」物品上的 QR 標籤' }, 400);
    const uid = uidOfToken(idToken), me = await fsUser(idToken, uid);
    if (!me || me.status !== 'approved' || me.warehouseRemoved || !me.realName) return json({ error: '只有已通過審核的團員可以接收' }, 403);
    const name = String(me.realName).trim(), tgt = String(target || '').trim();
    const tName = t => { t = String(t || ''); const i = t.indexOf(' - '); return i === -1 ? t : t.slice(i + 3); };
    if (!tgt || tName(tgt) !== name) return json({ error: 'bad target' }, 400);
    const [, boxId, , unitUid] = code.split('_');
    const tok = await saToken(env);
    const S = v => v && v.stringValue !== undefined ? v.stringValue : '';
    const findIn = d => { const vals = (((d.fields || {}).items || {}).arrayValue || {}).values || [];
      for (let i = 0; i < vals.length; i++) { const f = (vals[i].mapValue || {}).fields || {}; const us = ((f.units || {}).arrayValue || {}).values || [];
        for (let j = 0; j < us.length; j++) if (S(((us[j].mapValue || {}).fields || {}).uid) === unitUid) return { i, j }; } return null; };
    for (let attempt = 0; attempt < 3; attempt++) {
      let d = await fsGet(tok, `warehouse_boxes/${encodeURIComponent(boxId)}`), at = d && findIn(d);
      if (!at) { const all = await fetch(`${FS}/warehouse_boxes?pageSize=300`, { headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
        for (const x of all.documents || []) { const a = findIn(x); if (a) { d = x; at = a; break; } } }
      if (!d || !at) return json({ error: '找不到這一件物品（標籤可能已作廢），請找管理員' }, 404);
      const items = d.fields.items.arrayValue.values, itF = items[at.i].mapValue.fields;
      if (S(itF.itemType) === 'consumable') return json({ error: '耗材請找管理員出庫' }, 400);
      const units = itF.units.arrayValue.values, uF = units[at.j].mapValue.fields || (units[at.j].mapValue.fields = {});
      const st = S(uF.status) || 'in', from = S(uF.borrower);
      if (st === 'out' && tName(from) === name) return json({ error: '這一件已經在你名下了', already: true, item: S(itF.name), unitLabel: `第 ${at.j + 1}/${units.length} 件` }, 409);
      const now = Date.now();
      uF.status = { stringValue: 'out' }; uF.borrower = { stringValue: tgt }; uF.outAt = { integerValue: String(now) };
      uF.outBy = { stringValue: name }; uF.outByHelper = { booleanValue: false }; uF.outBySelf = { booleanValue: true };
      const outs = units.filter(u => S(((u.mapValue || {}).fields || {}).status) === 'out');
      itF.qty = { integerValue: String(units.length - outs.length) }; itF.checkedOutCount = { integerValue: String(outs.length) };
      itF.borrower = { stringValue: outs.length ? S(outs[outs.length - 1].mapValue.fields.borrower) : '' };
      const docPath = d.name.split('/documents/')[1];
      const w = await fetch(`${FS}/${docPath}?updateMask.fieldPaths=items&currentDocument.updateTime=${encodeURIComponent(d.updateTime)}`, { method: 'PATCH',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { items: d.fields.items } }) });
      if (w.status === 400 || w.status === 409 || w.status === 412) continue;   // 剛好有人同時改這一箱 → 重讀再試
      if (!w.ok) return json({ error: 'write failed ' + w.status }, 500);
      const action = st === 'out' ? '轉交' : '出庫', itemName = S(itF.name), unitLabel = `第 ${at.j + 1}/${units.length} 件`, boxName = S(d.fields.name);
      const t = new Date(now + 8 * 3600e3), timeStr = `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
      await fetch(`${FS}/warehouse_logs`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries({ type: action, itemName, qty: 1, boxName, target: st === 'out' ? `${from || '不詳'} → ${tgt}` : tgt,
          unitLabel, unitUid, timestamp: now, timeStr, operator: name, operatorId: uid, operatorRole: 'self', selfScan: true }).map(([k, v]) => [k, tv(v)])) }) }).catch(() => {});
      return json({ ok: true, action, from: st === 'out' ? from : '', item: itemName, unitLabel, box: boxName });
    }
    return json({ error: '這一箱剛好有人在改，請再掃一次' }, 409);
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// ===== 倉庫：用已公開的排班當「人員分類」（日期 → 各組名單，只回姓名）=====
async function whSchedRoute(req, env, json) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    const ok = me && me.status === 'approved' && !me.warehouseRemoved && (me.role === 'admin' || me.adminWarehouse || me.warehouseHelper);
    if (!ok) return json({ error: 'not allowed' }, 403);
    const tok = await saToken(env);
    const evs = (await fsList(tok, 'events')).filter(e => e.schedPublic).sort((a, b) => (b.schedPublicAt || 0) - (a.schedPublicAt || 0));
    for (const e of evs) {
      const dr = await fsGet(tok, `events/${e.id}/admin/draw`); if (!dr) continue;
      const sc = fobj(dr.fields).sched || {}, D = sc.days || {};
      const days = Object.keys(D).sort().map(d => ({ d, teams: (D[d] || []).filter(t => (t.m || []).length).map(t => ({ l: t.l || '', m: (t.m || []).filter(Boolean) })) })).filter(x => x.teams.length);
      if (days.length) return json({ ok: true, title: e.title || '', days });
    }
    return json({ ok: true, days: [] });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code ? e.code : 500); }
}
async function whMembersRoute(req, env, json) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    const ok = me && me.status === 'approved' && !me.warehouseRemoved && (me.role === 'admin' || me.adminWarehouse || me.warehouseHelper);
    if (!ok) return json({ error: 'not allowed' }, 403);
    const tok = await saToken(env);
    const list = (await fsList(tok, 'users'))
      .filter(u => u.status === 'approved' && !u.warehouseRemoved && u.realName)
      .map(u => ({ id: u.id, realName: u.realName, category: u.category || '', pictureUrl: u.pictureUrl || '', status: 'approved' }));
    return json({ ok: true, list });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code ? e.code : 500); }
}
const TW_CITIES = ['基隆市', '台北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'];
// ===== 全民醫護證：各縣市人數（只回傳統計數字，不含任何個資）=====
async function guardianMapRoute(req, env, json, ctx) {
  const cache = caches.default, key = new Request('https://cache.local/guardian-map-v1');
  const hit = await cache.match(key); if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } });
  try {
    const list = await fsList(await saToken(env), 'guardian');
    const counts = {}, pos = {}; let withCity = 0;
    list.forEach(g => { if (g.city) { counts[g.city] = (counts[g.city] || 0) + 1; withCity++; } if (g.pos) pos[g.pos] = (pos[g.pos] || 0) + 1; });
    const body = JSON.stringify({ ok: true, total: list.length, withCity, counts, pos, at: Date.now() });
    const res = new Response(body, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } });
    try { (ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(key, res.clone())) : await cache.put(key, res.clone())); } catch (e) {}
    return res;
  } catch (e) { return json({ error: 'failed' }, 500); }
}
// ===== 全民醫護證：守護編號（同一個 LINE 帳號永遠拿到同一號，流水號）=====
async function guardianNoRoute(req, env, json) {
  try {
    const { accessToken, city, pos, name, skills } = await req.json();
    if (!accessToken) return json({ error: 'missing token' }, 400);
    const cityOk = TW_CITIES.includes(city) ? city : '', posOk = String(pos || '').slice(0, 10);
    const [v, p] = await Promise.all([
      fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken)),
      fetch('https://api.line.me/v2/profile', { headers: { Authorization: 'Bearer ' + accessToken } })]);
    if (!v.ok || !p.ok) return json({ error: 'invalid token' }, 401);
    const info = await v.json(); if (String(info.client_id) !== LINE_CHANNEL_ID) return json({ error: 'wrong channel' }, 401);
    const { userId } = await p.json(); if (!/^U[0-9a-f]{32}$/.test(userId || '')) return json({ error: 'no user' }, 401);
    const tok = await saToken(env), H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const have = await fsGet(tok, `guardian/${userId}`);
    const lockFields = () => ({ name: tv(String(name || '').trim().slice(0, 8)), pos: tv(posOk), city: tv(cityOk), skills: tv((Array.isArray(skills) ? skills : []).slice(0, 6).map(Boolean)), locked: tv(true), cityAt: tv(Date.now()) });
    const canLock = cityOk && String(name || '').trim();
    if (have) {
      const h = fobj(have.fields);
      if (canLock) {   // 送出／修改：存下最新資料
        const f = lockFields();
        await fetch(`${FS}/guardian/${userId}?${Object.keys(f).map(k => 'updateMask.fieldPaths=' + k).join('&')}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: f }) });
        return json({ ok: true, no: +h.no, at: +h.at, locked: true, name: String(name).trim().slice(0, 8), pos: posOk, city: cityOk, skills: (skills || []).map(Boolean) });
      }
      return json({ ok: true, no: +h.no, at: +h.at, locked: !!h.locked, name: h.name || '', pos: h.pos || '', city: h.city || '', skills: h.skills || [] });
    }
    const DOC = `projects/${PROJECT_ID}/databases/(default)/documents`;
    const c = await fetch(`https://firestore.googleapis.com/v1/${DOC}:commit`, { method: 'POST', headers: H, body: JSON.stringify({ writes: [
      { transform: { document: `${DOC}/meta/guardian`, fieldTransforms: [{ fieldPath: 'count', increment: { integerValue: '1' } }] } }] }) });
    const cj = await c.json(); const no = +(((cj.writeResults || [])[0] || {}).transformResults || [{}])[0].integerValue;
    if (!no) return json({ error: 'counter failed' }, 500);
    const at = Date.now();
    const w = await fetch(`${FS}/guardian/${userId}?currentDocument.exists=false`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { no: tv(no), at: tv(at), ...(canLock ? lockFields() : {}) } }) });
    if (!w.ok) { const again = await fsGet(tok, `guardian/${userId}`); if (again) return json({ ok: true, no: +fobj(again.fields).no, at: +fobj(again.fields).at }); }
    return json({ ok: true, no, at, locked: !!canLock, ...(canLock ? { name: String(name).trim().slice(0, 8), pos: posOk, city: cityOk, skills: (skills || []).map(Boolean) } : {}) });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// 6 張衛教小卡排成一排（carousel），一次分享
function eduAllFlex(origin) {
  const bubbles = EDU.map(e => shareFlex({ ...EDU_CARDS['edu-' + e.img], id: 'edu-all' }, origin).contents);
  return { type: 'flex', altText: '【白沙屯拱天宮醫護團】衛教小卡 6 張（左右滑動看更多）', contents: { type: 'carousel', contents: bubbles } };
}
EDU_CARDS['member-entry'] = { id: 'member-entry', builtin: true, w: 1040, h: 1600, alt: '白沙屯拱天宮醫護團｜團員專區入口', imgUrl: `${SITE}/richmenu/member-entry.jpg?v=1`,
  title: '👥 團員專區入口', text: '團員：我的資料、排班、出席調查；管理員直接進後台；非團員會看到官方帳號。', url: 'https://liff.line.me/2011820105-x1KU6xLW?entry=1' };
EDU_CARDS['record-entry'] = { id: 'record-entry', builtin: true, w: 1040, h: 1600, alt: '白沙屯拱天宮醫護團｜救護紀錄表入口', imgUrl: `${SITE}/richmenu/record-entry.jpg?v=1`,
  title: '🚑 救護紀錄表入口', text: '團員：填寫救護紀錄；管理員、教官團直接開主控台；非團員會看到官方帳號。', url: 'https://liff.line.me/2011820105-6oXAxIEi?entry=1' };
// 倉庫入口：整張長圖滿版，點圖就開倉庫（不放分享鈕）
const whEntryFlex = c => ({ type: 'flex', altText: c.alt, contents: { type: 'bubble', size: 'giga',
  hero: { type: 'image', url: c.imgUrl, size: 'full', aspectRatio: '1040:1600', aspectMode: 'cover', action: { type: 'uri', label: '開啟倉庫管理', uri: c.url } } } });
// 連結加上來源（src=menu／share／n_xxx），網頁打開時記到使用分析「從哪裡進來」
function tagSrc(o, src) {
  o = JSON.parse(JSON.stringify(o));   // 複製一份，不改到共用的資料
  const walk = x => { if (Array.isArray(x)) return x.forEach(walk); if (!x || typeof x !== 'object') return;
    if (x.type === 'uri' && typeof x.uri === 'string' && /^https:\/\/(liff\.line\.me\/2011820105-|tsushin-buishatun\.pages\.dev\/)/.test(x.uri) && !/[?&]src=/.test(x.uri)) {
      const h = x.uri.indexOf('#'), a = h < 0 ? x.uri : x.uri.slice(0, h), t = h < 0 ? '' : x.uri.slice(h); x.uri = a + (a.includes('?') ? '&' : '?') + 'src=' + src + t; }
    Object.values(x).forEach(walk); };
  walk(o); return o; }
const cardFlex = (c, origin) => tagSrc(/^(wh|member|record)-entry$/.test(c.id) ? whEntryFlex(c) : c.id === 'guardian' ? guardianFlex() : c.id === 'edu-all' ? eduAllFlex(origin) : shareFlex(c, origin), 'share');
// 全民醫護證邀請卡（跟證件同風格：米白底、紅框、紅按鈕）
function guardianFlex() {
  const RED = '#D7262B', INK = '#1F1A18', SUB = '#6E625C';
  const step = (n, t) => ({ type: 'box', layout: 'vertical', flex: 1, borderWidth: '2px', borderColor: RED, cornerRadius: '8px', backgroundColor: '#FFFFFF', paddingTop: '8px', paddingBottom: '9px',
    contents: [{ type: 'text', text: 'STEP ' + n, size: 'xxs', color: RED, weight: 'bold', align: 'center' }, { type: 'text', text: t, size: 'sm', color: INK, weight: 'bold', align: 'center', margin: 'xs' }] });
  return { type: 'flex', altText: '全民醫護證｜不用證照，也能守護身邊的人', contents: { type: 'bubble', size: 'mega',
    hero: { type: 'image', url: `${SITE}/richmenu/guardian-banner.jpg?v=1`, size: 'full', aspectRatio: '1024:456', aspectMode: 'cover', action: { type: 'uri', label: '領取', uri: GUARDIAN_URL } },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', paddingTop: '6px', backgroundColor: '#FBF3E6', contents: [
      { type: 'box', layout: 'vertical', borderWidth: '2px', borderColor: RED, cornerRadius: '12px', backgroundColor: '#FFFCF7', paddingAll: '14px', contents: [
        { type: 'text', text: '我是守護員', size: 'xl', weight: 'bold', color: RED, align: 'center' },
        { type: 'text', text: 'I  AM  A  GUARDIAN', size: 'xxs', color: SUB, align: 'center', margin: 'xs' },
        { type: 'text', text: '不用證照，只要一顆願意幫忙的心，\n就能領一張屬於你的醫護證。', size: 'sm', color: '#3F3633', align: 'center', wrap: true, margin: 'md', lineSpacing: '4px' },
        { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'lg', contents: [step(1, '填姓名'), step(2, '選身分'), step(3, '勾技能')] },
      ] },
      { type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: RED, cornerRadius: '10px', paddingAll: '13px', action: { type: 'uri', label: '領取我的全民醫護證', uri: GUARDIAN_URL },
        contents: [{ type: 'text', text: '領取我的全民醫護證  ›', size: 'md', weight: 'bold', color: '#FFFFFF', align: 'center' }] },
      { type: 'text', text: '白沙屯拱天宮醫護團 ・ 聖容慈悲心 佑民護萬年', size: 'xxs', color: '#A39690', align: 'center', margin: 'lg' },
    ] } } };
}
// ===== 分享卡片：管理員上傳圖文，團員用 LIFF shareTargetPicker 轉傳給親友／群組 =====
async function shareCardRoute(req, env, json) {
  try {
    const body = await req.json(), { idToken, action } = body;
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    if (!(await fullAdmin(me, idToken, env))) return json({ error: '只有完整管理員可以管理分享卡片' }, 403);
    const tok = await saToken(env), H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const patch = (path, fields) => fetch(`${FS}/${path}?${Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&')}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, tv(v)])) }) });
    const clean = b => ({ title: String(b.title || '').slice(0, 60), text: String(b.text || '').slice(0, 300), btn: String(b.btn || '').slice(0, 30),
      url: /^https:\/\/[^\s]{4,400}$/.test(b.url || '') ? b.url : 'https://line.me/R/ti/p/@393geitc' });
    if (action === 'list') return json({ ok: true, cards: [...(await fsList(tok, 'share')).sort((x, y) => (y.at ?? 0) - (x.at ?? 0)), ...Object.values(EDU_CARDS)].map(c => ({ ...c, flex: cardFlex(c, new URL(req.url).origin) })) });
    if (action === 'add') {
      const data = String(body.data || '');
      if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 1000000) return json({ error: '圖片太大或格式不對' }, 400);
      const rnd = new Uint8Array(9); crypto.getRandomValues(rnd); const id = b64url(rnd);
      const w1 = await patch(`share_img/${id}`, { data }); if (!w1.ok) return json({ error: 'save failed ' + w1.status }, 500);
      await patch(`share/${id}`, { ...clean(body), w: Math.max(1, +body.w || 1), h: Math.max(1, +body.h || 1), at: Date.now() });
      return json({ ok: true, id });
    }
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return json({ error: 'bad id' }, 400);
    if (action === 'edit') { await patch(`share/${id}`, clean(body)); return json({ ok: true }); }
    if (action === 'del') {
      await fetch(`${FS}/share/${id}`, { method: 'DELETE', headers: H }); await fetch(`${FS}/share_img/${id}`, { method: 'DELETE', headers: H });
      return json({ ok: true });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code || 500); }
}
// ===== 團員專區：我的排班（管理員在排班表打開「公開給團員看」才會回傳）=====
// 同一台伺服器短時間內重複讀的共用資料（出席調查清單、名冊、回覆、排班）先記在記憶體，省讀取次數也比較快
const MEMO = new Map();
function memo(key, ttl, fn) { const m = MEMO.get(key), now = Date.now(); if (m && now - m.at < ttl) return m.p;
  const p = Promise.resolve().then(fn); MEMO.set(key, { at: now, p }); p.catch(() => { if (MEMO.get(key) && MEMO.get(key).p === p) MEMO.delete(key); });
  if (MEMO.size > 200) for (const [k, v] of MEMO) if (now - v.at > 600e3) MEMO.delete(k); return p; }
async function mySchedRoute(req, env, json) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken);
    // 能同時做的都同時做（以前一個一個等，團員首頁「我的排班」要等很久）
    const [me, tok] = await Promise.all([fetch(`${FS}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } }), saToken(env)]);
    if (!me.ok) return json({ error: 'not signed in' }, 401);
    const u = fobj((await me.json()).fields);
    if (u.status !== 'approved' || (!u.rosterId && !u.realName)) return json({ events: [] });
    // 沒對應名冊的帳號：用帳號上的真實姓名比對排班表
    const [ro, evAll] = await Promise.all([u.rosterId ? fsGet(tok, `member_roster/${encodeURIComponent(u.rosterId)}`) : null, memo('events', 30e3, () => fsList(tok, 'events'))]);
    if (!ro && !u.realName) return json({ events: [] });
    const roF = ro ? fobj(ro.fields) : { name: u.realName, idCard: u.idCard || '' }, myKey = normName(roF.name), myG = String(roF.idCard || '').toUpperCase()[1] === '2' ? '8' : '7';
    const evs = evAll.filter(e => e.schedPublic || e.askGroups);
    const P = {}; evs.forEach(e => { P[e.id] = Promise.all([memo('rsp:' + e.id, 60e3, () => fsList(tok, `events/${e.id}/responses`)), e.askGroups ? memo('grp:' + e.id, 30e3, () => fsGet(tok, `events/${e.id}/admin/groups`)) : null,
      e.schedPublic ? memo('draw:' + e.id, 20e3, () => fsGet(tok, `events/${e.id}/admin/draw`)) : null, e.schedPublic && u.rosterId ? fsGet(tok, `events/${e.id}/admin/self_${u.rosterId}`) : null]); });
    const roster = evs.some(e => e.schedPublic) ? (await memo('roster', 300e3, () => fsList(tok, 'member_roster'))).filter(x => !x.left) : [], byName = {};
    roster.forEach(x => { const k = normName(x.name); if (k && !byName[k]) byName[k] = x; });
    const catOf = k => { const c = String((byName[k] || {}).cert || '').toUpperCase().replace(/[-\s]/g, ''); return c.includes('護理') || c.includes('醫師') ? 'N' : c.includes('EMTP') || c.includes('EMT2') ? 'T2' : c.includes('EMT1') ? 'T1' : 'O'; };
    const EQN = { kit: '救護包', ambu: 'AMBU包', inst: '儀器包' };
    const res = await Promise.all(evs.map(async e => {
      const [rsp, gd, dr, selfDoc] = await P[e.id];
      const latest = {}; rsp.forEach(x => { const k = normName(x.name); if (k && (!latest[k] || (x.createdAt || 0) >= (latest[k].createdAt || 0))) latest[k] = x; });
      let grp = null;
      if (e.askGroups) {
        const fin = gd ? (fobj(gd.fields).final || {}) : {};
        const GP = parseGroups(e.groupsText), order = GP.gs.map(g => g.n);
        const picks = ((latest[myKey] || {}).groups || []).filter(Boolean);
        const led = GP.gs.filter(g => g.lead.some(l => leadKey(l.n) === myKey)).map(g => g.n);   // 組長／副組長＝自己帶的組
        const final = [...new Set([...led, ...Object.keys(fin).filter(g => fin[g] && fin[g][myKey])])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const role = [...GP.core.filter(c => leadKey(c.n) === myKey).map(c => c.t), ...GP.gs.flatMap(g => g.lead.filter(l => leadKey(l.n) === myKey).map(l => g.n + ' ' + l.t))];
        if (picks.length || final.length || role.length) grp = { picks, final, role };
      }
      if (!dr) return grp ? { id: e.id, title: e.title || '', name: myKey, days: [], cats: {}, cmd: [], g: myG, plan: [], grp } : null;
      const sc = fobj(dr.fields).sched || {}, days = sc.days || {}, info = sc.info || {};
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
      // 我的住宿／中巴：管理員設定 > 自己登記 > 自動
      const self = selfDoc ? (fobj(selfDoc.fields).days || {}) : {};
      const att = (sc.att || {})[myKey] || {}, car = (sc.car || {})[myKey] || {}, meal = (sc.meal || {})[myKey] || {};
      const inT = d => (days[d] || []).some(t => (t.m || []).includes(myKey));
      const W = d => { const w0 = (att.w || {})[d]; return w0 === undefined ? (inT(d) ? '2' : '') : (w0 === 'x' ? '' : w0); };
      const S = d => { const s0 = (att.s || {})[d], ss = (self[d] || {}).s; return s0 === 'x' ? '' : s0 ? s0 : ss && ss !== 'x' ? ss : ''; };
      const plan = d => { const w = W(d), veh = ['1', '4', '5', '6'].includes(w) ? w : '9';
        const au = !w ? { o: '', y: '', h: '' } : w === '1' ? { o: '1', y: '1', h: '1' } : { o: S(isoAddW(d, -1)) ? veh : '', y: veh, h: S(d) ? veh : '' };
        const st = { ...(self[d] || {}), ...((car[d]) || {}) }, o = { d, w, s: S(d), adminS: (att.s || {})[d] !== undefined, adminCar: {} };
        ['o', 'y', 'h'].forEach(f => { const v = st[f]; o[f] = v === undefined ? au[f] : (v === 'x' ? '' : v); o.adminCar[f] = (car[d] || {})[f] !== undefined; });
        o.adminMeal = {}; ['l', 'n'].forEach(f => { const ex = (meal[d] || {})[f], sv = (self[d] || {})[f], m = ex !== undefined ? ex : sv; o[f] = !m || m === 'x' ? '' : m; o.adminMeal[f] = ex !== undefined; });
        return o; };
      // 每一段連續排班的前一天都要問住宿（分開來的也是）；起駕第一天就不問前一天
      const ds = mine.map(x => x.d), pres = ds.filter(d => !ds.includes(isoAddW(d, -1)) && !/起駕/.test((info[d] || {}).tag || '')).map(d => isoAddW(d, -1)).filter(p => p >= (sc.start || Object.keys(days).sort()[0] || p));
      const planDays = [...new Set([...pres, ...ds])].sort();   // 排班前一天＋排班的日子
      return { id: e.id, title: e.title || '', name: myKey, days: mine, cats, cmd, g: myG, plan: planDays.map(plan), grp };
    }));
    return json({ events: res.filter(Boolean) });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// ===== 選組：管理員貼的分組架構文字 → 組別、組長 =====
function parseGroups(t) {
  const gs = [], core = []; let cur = null, started = false;
  String(t || '').split(/\r?\n/).forEach(l => {
    const s = l.trim(); if (!s) return;
    const m = /^(?:\d+\s*[.、)）]|\d\uFE0F?\u20E3)\s*(.+)$/.exec(s);
    if (m) { cur = { n: m[1].trim(), lead: [], duty: [] }; gs.push(cur); started = true; return; }
    if (/^[━─=＝\-]{3,}/.test(s)) { cur = null; return; }
    if (!cur) { const c = /^(團長|副團長|秘書長|指揮官|副指揮官)\s*[:：]\s*(.+)$/.exec(s); if (c && !started) core.push({ t: c[1], n: c[2] }); return; }
    const ld = /^(.{0,8}組長)\s*[:：]\s*(.+)$/.exec(s);
    if (ld) { cur.lead.push({ t: ld[1], n: ld[2].trim() }); return; }
    const d = /^(?:▫️|▫|・|•|‧|-|\*|◦)\s*(.+)$/.exec(s);
    cur.duty.push(d ? d[1] : s);
  });
  return { gs: gs.filter(g => g.n), core };
}
const leadKey = n => normName(String(n || '').replace(/[（(].*$/, ''));
async function groupMe(idToken, env) {
  const me = await fetch(`${FS}/users/${encodeURIComponent(uidOfToken(idToken))}`, { headers: { Authorization: 'Bearer ' + idToken } });
  if (!me.ok) return null;
  const u = fobj((await me.json()).fields); if (u.status !== 'approved') return null;
  const tok = await saToken(env); let key = '';
  if (u.rosterId) { const ro = await fsGet(tok, `member_roster/${encodeURIComponent(u.rosterId)}`); if (ro) key = normName(fobj(ro.fields).name); }
  return { u, tok, key, admin: u.role === 'admin' || u.adminMember === true, by: key || normName(u.realName) };
}
// 組長／管理員看選組名單：{ idToken, eid? }（沒 eid ＝ 只回清單和人數）
async function groupsRoute(req, env, json) {
  try {
    const { idToken, eid } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const M = await groupMe(idToken, env); if (!M) return json({ error: 'not member' }, 403);
    const { tok, key, admin } = M;
    const evs = (await fsList(tok, 'events')).filter(e => e.askGroups && (!eid || e.id === eid));
    const out = []; let roster = null;
    if (!admin) return json({ events: [], admin });   // 選組確認只在管理員後台做
    const want = evs.filter(e => parseGroups(e.groupsText).gs.length);
    const pre = {}; want.forEach(e => { pre[e.id] = Promise.all([fsList(tok, `events/${e.id}/responses`), fsGet(tok, `events/${e.id}/admin/groups`)]); });
    if (eid && want.length) { roster = {}; (await fsList(tok, 'member_roster')).filter(x => !x.left).forEach(x => { const k = normName(x.name); if (k && !roster[k]) roster[k] = x; }); }
    for (const e of want) {
      const GP = parseGroups(e.groupsText);
      const mine = GP.gs;
      const [rsp, gd] = await pre[e.id];
      const latest = {}; rsp.forEach(x => { const k = normName(x.name); if (k && (!latest[k] || (x.createdAt || 0) >= (latest[k].createdAt || 0))) latest[k] = x; });
      const fin = gd ? (fobj(gd.fields).final || {}) : {};
      const att = Object.keys(latest).filter(k => ['yes', 'join'].includes(latest[k].attend));
      const person = k => { const r = latest[k] || {}, ro = (roster || {})[k] || {}; return { k, name: r.name || k, attend: r.attend || '', picks: r.groups || [], cert: ro.cert || '', pos: ro.position || '' }; };
      const groups = mine.map(g => {
        const f = fin[g.n] || {};
        const ks = [...new Set([...att.filter(k => (latest[k].groups || []).includes(g.n)), ...Object.keys(f)])];
        return eid ? { n: g.n, lead: g.lead, people: ks.map(k => ({ ...person(k), ok: f[k] || '' })) }
          : { n: g.n, picked: ks.length, ok: Object.keys(f).length };
      });
      out.push({ id: e.id, title: e.title || '', groups, ...(eid ? { all: att.map(person) } : {}) });
    }
    return json({ events: out, admin });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// 確認／取消某人在某組：{ idToken, eid, g, k, on }
async function groupSetRoute(req, env, json) {
  try {
    const { idToken, eid, g, k, ks, on } = await req.json();
    const keys = (Array.isArray(ks) ? ks : [k]).filter(x => x && String(x).length <= 20).slice(0, 400);
    if (!idToken || !/^[A-Za-z0-9_-]{1,64}$/.test(eid || '') || !g || !keys.length) return json({ error: 'missing' }, 400);
    const M = await groupMe(idToken, env); if (!M) return json({ error: 'not member' }, 403);
    const { tok, key, admin, by } = M;
    const ev = await fsGet(tok, `events/${eid}`); if (!ev) return json({ error: 'no event' }, 404);
    const e = fobj(ev.fields), G = parseGroups(e.groupsText).gs.find(x => x.n === g);
    if (!e.askGroups || !G) return json({ error: '沒有這個組別' }, 404);
    if (!admin) return json({ error: '只有管理員可以確認組別' }, 403);
    const path = `events/${eid}/admin/groups`, cur = await fsGet(tok, path), fin = cur ? (fobj(cur.fields).final || {}) : {};
    const m = { ...(fin[g] || {}) }, skipped = [];
    keys.forEach(x => { const nk = normName(x);
      if (on && Object.keys(fin).some(o => o !== g && fin[o] && fin[o][nk])) { skipped.push(nk); return; }   // 一人只能在一組
      if (on) m[nk] = by || '管理員'; else delete m[nk]; });
    if (on && keys.length === 1 && skipped.length) return json({ error: '這個人已經在別組了，要先在原組取消' }, 409);
    fin[g] = m; if (!Object.keys(m).length) delete fin[g];
    const w = await fetch(`${FS}/${path}?updateMask.fieldPaths=final&updateMask.fieldPaths=at`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { final: tv(fin), at: { timestampValue: new Date().toISOString() } } }) });
    if (!w.ok) return json({ error: 'write failed ' + w.status }, 500);
    return json({ ok: true, final: fin[g] || {}, skipped });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// 團員看自己組別的組長、組員：{ idToken, eid }
async function myGroupRoute(req, env, json) {
  try {
    const { idToken, eid } = await req.json();
    if (!idToken || !/^[A-Za-z0-9_-]{1,64}$/.test(eid || '')) return json({ error: 'missing' }, 400);
    const M = await groupMe(idToken, env); if (!M) return json({ error: 'not member' }, 403);
    const { tok, key, admin } = M;
    const [ev, gd, rsp] = await Promise.all([fsGet(tok, `events/${eid}`), fsGet(tok, `events/${eid}/admin/groups`), fsList(tok, `events/${eid}/responses`)]);
    if (!ev) return json({ error: 'no event' }, 404);
    const e = fobj(ev.fields); if (!e.askGroups) return json({ groups: [] });
    const GP = parseGroups(e.groupsText), fin = gd ? (fobj(gd.fields).final || {}) : {};
    const nm = {}; rsp.forEach(x => { const k = normName(x.name); if (k && !nm[k]) nm[k] = String(x.name || '').trim(); });
    const mine = GP.gs.filter(g => g.lead.some(l => leadKey(l.n) === key) || (fin[g.n] && fin[g.n][key]));
    return json({ core: GP.core, groups: mine.map(g => ({ n: g.n, lead: g.lead, duty: g.duty,
      members: Object.keys(fin[g.n] || {}).filter(k => !g.lead.some(l => leadKey(l.n) === k)).map(k => nm[k] || k) })) });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// ===== 小組長檢查：組長確認整組當天用餐、到勤、配備、服裝儀容、就寢前充電 =====
// { idToken, eid, d, l?(管理員看別組), save?: { att, meal:{k:{l,n}}, eq, dress, charge } }
async function leadRoute(req, env, json) {
  try {
    const { idToken, eid, d, l, save } = await req.json();
    if (!idToken || !/^[A-Za-z0-9_-]{1,64}$/.test(eid || '') || !/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken);
    const meR = await fetch(`${FS}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } });
    if (!meR.ok) return json({ error: 'not signed in' }, 401);
    const u = fobj((await meR.json()).fields); if (u.status !== 'approved') return json({ error: 'not member' }, 403);
    const admin = u.role === 'admin' || u.adminMember === true;
    const tok = await saToken(env);
    const [dr, roster] = await Promise.all([fsGet(tok, `events/${eid}/admin/draw`), memo('roster', 300e3, () => fsList(tok, 'member_roster')).then(L => L.filter(x => !x.left))]);
    const byName = {}; roster.forEach(x => { const k = normName(x.name); if (k && !byName[k]) byName[k] = x; });
    const me = u.rosterId ? roster.find(x => x.id === u.rosterId) : null, myKey = me ? normName(me.name) : '';
    const sc = dr ? (fobj(dr.fields).sched || {}) : {}, teams = (sc.days || {})[d] || [];
    const t = teams.find(x => l ? x.l === l : (x.m || [])[0] === myKey);
    if (!t) return json({ error: '這天你不是小組長' }, 403);
    if (!admin && (t.m || [])[0] !== myKey) return json({ error: '只有這組的小組長可以確認' }, 403);
    const path = `events/${eid}/admin/lead_${d}_${encodeURIComponent(t.l)}`;
    const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const selfOf = async k => { const ro = byName[k]; if (!ro) return null; const s0 = await fsGet(tok, `events/${eid}/admin/self_${ro.id}`); return { ro, days: s0 ? (fobj(s0.fields).days || {}) : {} }; };
    if (save) {
      const by = me ? me.name : (u.realName || ''), now = new Date().toISOString(), cur = await fsGet(tok, path), old = cur ? fobj(cur.fields) : {};
      const doc = { ...old, team: t.l, d, by, at: Date.now() };
      ['att', 'bff', 'eq', 'dress', 'charge'].forEach(f => { if (save[f] && typeof save[f] === 'object') { doc[f] = save[f]; doc[f + 'At'] = Date.now(); doc[f + 'By'] = by; } });
      if (save.meal && typeof save.meal === 'object') {   // 用餐：寫回每個人自己的登記（管理員設定過的不動）
        const adm = sc.meal || {};
        for (const k of (t.m || [])) { const v = save.meal[k]; if (!v) continue; const S = await selfOf(k); if (!S) continue;
          const dv = { ...(S.days[d] || {}) };
          ['l', 'n'].forEach(f => { if (((adm[k] || {})[d] || {})[f] !== undefined) return; if (['葷', '素', '自'].includes(v[f])) dv[f] = v[f]; else if (v[f] === '') delete dv[f]; });
          S.days[d] = dv;
          await fetch(`${FS}/events/${eid}/admin/self_${S.ro.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { key: tv(k), days: tv(S.days), at: { timestampValue: now } } }) }); }
        doc.mealAt = Date.now(); doc.mealBy = by;
      }
      const w = await fetch(`${FS}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, tv(v)])) }) });
      if (!w.ok) return json({ error: 'write failed ' + w.status }, 500);
    }
    const ck = await fsGet(tok, path), adm = sc.meal || {};
    const members = await Promise.all((t.m || []).map(async k => { const S = await selfOf(k), A = (adm[k] || {})[d] || {}, sd = S ? (S.days[d] || {}) : {};
      const pick = f => A[f] !== undefined ? A[f] : sd[f]; return { k, name: (byName[k] || {}).name || k, cert: (byName[k] || {}).cert || '', l: pick('l') || '', n: pick('n') || '', lockL: A.l !== undefined, lockN: A.n !== undefined }; }));
    return json({ ok: true, team: t.l, d, eq: t.eq || {}, note: t.note || '', members, check: ck ? fobj(ck.fields) : {}, leader: (t.m || [])[0] });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
const isoAddW = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 團員自己登記某天的住宿／中巴：{ idToken, eid, d, s:'7'|'8'|'x'|null, o/y/h:'9'|'x'|null }（null = 回到自動）
async function myPlanRoute(req, env, json) {
  try {
    const { idToken, eid, d, ...v } = await req.json();
    if (!idToken || !/^[A-Za-z0-9_-]{1,64}$/.test(eid || '') || !/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken);
    const me = await fetch(`${FS}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } });
    if (!me.ok) return json({ error: 'not signed in' }, 401);
    const u = fobj((await me.json()).fields);
    if (u.status !== 'approved' || !u.rosterId) return json({ error: 'not member' }, 403);
    const tok = await saToken(env);
    const ev = await fsGet(tok, `events/${eid}`); if (!ev || !fobj(ev.fields).schedPublic) return json({ error: '排班未公開' }, 403);
    const ro = await fsGet(tok, `member_roster/${encodeURIComponent(u.rosterId)}`); if (!ro) return json({ error: 'no roster' }, 403);
    const key = normName(fobj(ro.fields).name), path = `events/${eid}/admin/self_${u.rosterId}`;
    const cur = await fsGet(tok, path), days = cur ? (fobj(cur.fields).days || {}) : {};
    const dv = { ...(days[d] || {}) };
    if ('s' in v) { if (v.s === null) delete dv.s; else if (['7', '8', 'x'].includes(v.s)) dv.s = v.s; }
    ['o', 'y', 'h'].forEach(f => { if (f in v) { if (v[f] === null) delete dv[f]; else if (['9', 'x'].includes(v[f])) dv[f] = v[f]; } });
    ['l', 'n'].forEach(f => { if (f in v) { if (v[f] === null || v[f] === 'x') delete dv[f]; else if (['葷', '素', '自'].includes(v[f])) dv[f] = v[f]; } });
    days[d] = dv; if (!Object.keys(dv).length) delete days[d];
    const w = await fetch(`${FS}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { key: tv(key), days: tv(days), at: { timestampValue: new Date().toISOString() } } }) });
    if (!w.ok) return json({ error: 'write failed ' + w.status }, 500);
    return json({ ok: true });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}
// 管理員催促團員登記（LINE 推播）：{ idToken, names:[...], text }
async function remindRoute(req, env, json) {
  try {
    const { idToken, names, text } = await req.json();
    if (!idToken || !Array.isArray(names) || !names.length) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    if (!memberAdmin(me)) return json({ error: '只有團員專區管理員可以催促' }, 403);
    if (!env.LINE_BOT_TOKEN) return json({ error: 'LINE_BOT_TOKEN 尚未設定' }, 501);
    const tok = await saToken(env), want = new Set(names.map(normName));
    const ids = [], found = new Set();
    (await fsList(tok, 'member_roster')).filter(x => !x.left).forEach(x => { const k = normName(x.name); if (want.has(k) && x.boundUserId && !found.has(k)) { found.add(k); ids.push(x.boundUserId); } });
    const noLine = [...want].filter(k => !found.has(k));
    if (!ids.length) return json({ ok: true, sent: 0, noLine });
    const msg = { type: 'flex', altText: String(text || '請到團員專區登記').slice(0, 300), contents: { type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'md', contents: [
        { type: 'text', text: '📣 醫護團提醒', weight: 'bold', size: 'lg', color: '#c2414f' },
        { type: 'text', text: String(text || '').slice(0, 300), wrap: true, size: 'sm', color: '#374151' } ] },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
        { type: 'button', style: 'primary', color: '#D65A68', action: { type: 'uri', label: '打開團員專區登記', uri: 'https://liff.line.me/2011820105-x1KU6xLW?src=n_remind' } } ] } } };
    const r = await fetch('https://api.line.me/v2/bot/message/multicast', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_BOT_TOKEN },
      body: JSON.stringify({ to: ids.slice(0, 500), messages: [msg] }) });
    if (!r.ok) return json({ error: 'LINE 傳送失敗：' + (await r.text()).slice(0, 200) }, 502);
    try { await writeUsage(tok, { pg: 'line', f: [['sent_n_remind', ids.length]] }); } catch (e) {}
    return json({ ok: true, sent: ids.length, noLine });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code || 500); }
}
// 管理員催團員登記：LINE 推播提醒（只有團員專區管理員可以用）
function noticeFlex(body, ttl, msg, btn, link) {
  // 版型：衛教小卡同色系漸層抬頭＋白底資訊表格（正式通知風格）
  const kind = String(body.kind || '通知').slice(0, 10), sub = String(body.sub || '').slice(0, 60);
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 6).map(x => [String(x[0] || '').slice(0, 8), String(x[1] || '').slice(0, 60)]).filter(x => x[0] && x[1]);
  const [c1, c2, en, ic] = ({ '用餐登記': ['#F97316', '#DC2626', 'MEAL REGISTRATION', 'meal'], '排班分享': ['#14B8A6', '#0F766E', 'SCHEDULE SHARED', 'sched'] })[kind] || ['#E0566A', '#9F1D2B', 'NOTICE', 'bell'];
  const rowBox = ([k, v], i) => ({ type: 'box', layout: 'horizontal', paddingTop: '10px', paddingBottom: '10px', contents: [
    { type: 'text', text: k, size: 'sm', color: '#6B7280', flex: 2, gravity: 'center' },
    { type: 'text', text: v, size: 'sm', color: '#111827', weight: 'bold', flex: 5, align: 'end', wrap: true, gravity: 'center' }] });
  const table = [];
  rows.forEach((r, i) => { if (i) table.push({ type: 'separator', color: '#EEF0F3' }); table.push(rowBox(r, i)); });
  return { type: 'flex', altText: `【白沙屯拱天宮醫護團】${ttl}`, contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '20px', paddingBottom: '18px', background: { type: 'linearGradient', angle: '135deg', startColor: c1, endColor: c2 }, contents: [
      { type: 'text', text: en, size: 'xxs', color: '#FFFFFFD9', weight: 'bold' },
      { type: 'box', layout: 'vertical', width: '24px', height: '3px', backgroundColor: '#FFFFFFD9', cornerRadius: '2px', margin: 'sm', contents: [] },
      { type: 'text', text: ttl, size: 'xl', color: '#FFFFFF', weight: 'bold', wrap: true, margin: 'md', offsetEnd: '0px' },
      ...(sub ? [{ type: 'text', text: sub, size: 'xs', color: '#FFFFFFE0', wrap: true, margin: 'xs' }] : []),
      { type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '16px', offsetEnd: '16px', width: '52px', height: '52px',
        contents: [{ type: 'image', url: `${SITE}/richmenu/ic-n-${ic}.png`, size: 'full', aspectRatio: '1:1', aspectMode: 'fit' }] },
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '20px', paddingTop: '10px', paddingBottom: '6px', contents: [
      ...table,
      ...(msg ? [{ type: 'text', text: msg, size: 'sm', color: '#4B5563', wrap: true, margin: table.length ? 'lg' : 'md', lineSpacing: '4px' }] : []),
    ] },
    footer: { type: 'box', layout: 'vertical', paddingAll: '20px', paddingTop: '14px', spacing: 'md', contents: [
      { type: 'button', style: 'primary', color: c2, height: 'sm', action: { type: 'uri', label: String(btn || '前往登記').slice(0, 20), uri: link } },
      { type: 'text', text: '白沙屯拱天宮醫護團 ・ ' + kind + '通知', size: 'xxs', color: '#9CA3AF', align: 'center' }] },
    styles: { footer: { separator: false } } } };
}
async function nudgeRoute(req, env, json) {
  try {
    if (!env.LINE_BOT_TOKEN) return json({ error: 'LINE_BOT_TOKEN 尚未設定' }, 501);
    const body = await req.json(), { idToken, uids, text, title, url, action, btn } = body;
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    if (!memberAdmin(me)) return json({ error: '只有團員專區管理員可以催' }, 403);
    const quota = async () => {
      const [q, c] = await Promise.all([lineApi(env, '/v2/bot/message/quota'), lineApi(env, '/v2/bot/message/quota/consumption')]);
      const qj = q.ok ? await q.json() : {}, cj = c.ok ? await c.json() : {};
      return { type: qj.type || '', limit: qj.type === 'limited' ? qj.value : null, used: cj.totalUsage ?? null };
    };
    if (action === 'quota') return json({ ok: true, ...(await quota()) });
    const list = [...new Set((uids || []).filter(u => /^U[0-9a-f]{32}$/.test(u)))].slice(0, 500);
    if (!list.length) return json({ error: '這些人都還沒綁定 LINE' }, 400);
    const msg = String(text || '').slice(0, 600), ttl = String(title || '提醒').slice(0, 40);
    const link = /^https:\/\/liff\.line\.me\//.test(url || '') ? url : 'https://liff.line.me/2011820105-x1KU6xLW';
    const ncode = { '排班分享': 'n_sched', '用餐登記': 'n_meal' }[body.kind] || 'n_other';
    const flex = tagSrc(noticeFlex(body, ttl, msg, btn, link), ncode);
    const r = await lineApi(env, '/v2/bot/message/multicast', { method: 'POST', type: 'application/json', body: JSON.stringify({ to: list, messages: [flex] }) });
    if (!r.ok) return json({ error: 'LINE ' + r.status + ' ' + (await r.text()).slice(0, 200) }, 502);
    try { await writeUsage(await saToken(env), { pg: 'line', f: [['sent_' + ncode, list.length]] }); } catch (e) {}
    return json({ ok: true, sent: list.length, ...(await quota()) });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code || 500); }
}
// 指揮官／團長唯讀檢視排班、出勤住宿、座車、用餐（管理員在排班表「分享」給指定的人）
async function viewSchedRoute(req, env, json) {
  try {
    const { idToken, eid } = await req.json();
    if (!idToken || !/^[A-Za-z0-9_-]{1,64}$/.test(eid || '')) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken);
    const me = await fsUser(idToken, uid);
    if (!me || me.status !== 'approved') return json({ error: '請先登入團員專區' }, 403);
    const tok = await saToken(env);
    const ev = await fsGet(tok, `events/${eid}`); if (!ev) return json({ error: '找不到這個活動' }, 404);
    const e = fobj(ev.fields);
    if (!(e.viewers || []).includes(uid) && !memberAdmin(me)) return json({ error: '你沒有這份排班的檢視權限，請洽管理員' }, 403);
    const dr = await fsGet(tok, `events/${eid}/admin/draw`), d = dr ? fobj(dr.fields) : {};
    const resp = (await fsList(tok, `events/${eid}/responses`)).map(x => ({ id: x.id, name: x.name, attend: x.attend, rosterId: x.rosterId || '', createdAt: x.createdAt || 0 }));
    const roster = (await fsList(tok, 'member_roster')).filter(x => !x.left).map(x => ({ id: x.id, name: x.name, nameRaw: x.nameRaw || '', cert: x.cert || '', position: x.position || '', rowIndex: x.rowIndex ?? null, serial: x.serial ?? null,
      idCard: 'X' + (String(x.idCard || '').toUpperCase()[1] || '') }));   // 只給性別碼，不給身分證
    const self = (await fsList(tok, `events/${eid}/admin`)).filter(x => x.id.startsWith('self_')).map(x => ({ key: x.key, days: x.days || {} }));
    return json({ ok: true, event: { id: eid, title: e.title || '', date: e.date || '', schedPublic: !!e.schedPublic },
      draw: { map: d.map || {}, by2: d.by2 || {}, groupOverride: d.groupOverride || {}, sched: d.sched || null }, resp, roster, self });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e && e.code || 500); }
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

// ===== 衛教網頁統計（匿名計數，不存任何個資）=====
const EDU_K = ['wound', 'sun', 'foot', 'water', 'heat', 'help'];
const eduOk = e => /^(visit|uniq|all|c_line|c_fb|c_ig)$/.test(e) || new RegExp(`^(open|done)_(${EDU_K.join('|')})$`).test(e);
async function eduHitRoute(req, env, json) {
  try {
    const b = await req.json().catch(() => ({}));
    const evs = [...new Set((Array.isArray(b.e) ? b.e : [b.e]).filter(x => typeof x === 'string' && eduOk(x)))].slice(0, 4);
    if (!evs.length) return json({ ok: false }, 400);
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const doc = n => `projects/${PROJECT_ID}/databases/(default)/documents/stats/${n}`;
    const inc = f => ({ fieldPath: f, increment: { integerValue: '1' } });
    const writes = [{ transform: { document: doc('edu'), fieldTransforms: evs.map(inc) } }];
    if (evs.some(e => e === 'visit' || e === 'uniq')) writes.push({ transform: { document: doc('edu_daily'), fieldTransforms: evs.filter(e => e === 'visit' || e === 'uniq').map(e => inc(`${e}_${day}`)) } });
    const tok = await saToken(env);
    const r = await fetch(`${FS}:commit`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
    return json({ ok: r.ok });
  } catch (e) { return json({ ok: false }, 500); }
}
async function eduStatsRoute(req, env, json) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const me = await fsUser(idToken, uidOfToken(idToken));
    if (!(await fullAdmin(me, idToken, env))) return json({ error: '只有完整管理員可以看統計' }, 403);
    const tok = await saToken(env);
    const [a, d] = await Promise.all([fsGet(tok, 'stats/edu'), fsGet(tok, 'stats/edu_daily')]);
    return json({ ok: true, total: a ? fobj(a.fields) : {}, daily: d ? fobj(d.fields) : {} });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

// ===== 使用分析（只有開發者看得到）=====
// 網頁離開時送一次：{ p: 頁面, v: 開啟次數, q: 今天第一次開, f: { 功能: 次數 }, t: Firebase idToken（可省略＝匿名） }
// 存在 usage_daily/{YYYYMMDD}（每天一份）與 usage_meta/last（每人最後使用時間、姓名）；前端讀不到，只能透過 /usage-stats
const USAGE_PAGES = ['member', 'record', 'warehouse', 'attend', 'edu', 'guardian', 'join', 'journey', 'share'];   // line＝官方帳號，只由伺服器自己記
let DEV_CACHE = null;
async function devUid(tok) { if (DEV_CACHE && Date.now() - DEV_CACHE.at < 600e3) return DEV_CACHE.uid;
  const d = await fsGet(tok, 'meta/developer'); DEV_CACHE = { uid: d ? (fobj(d.fields).uid || '') : '', at: Date.now() }; return DEV_CACHE.uid; }
const fq = (...a) => a.map(x => '`' + String(x).replace(/[`\\]/g, '') + '`').join('.');
async function usageRoute(req, env, json) {
  try {
    const b = JSON.parse(await req.text() || '{}');
    const pg = String(b.p || ''); if (!USAGE_PAGES.includes(pg)) return json({ ok: false }, 400);
    const v = Math.min(5, Math.max(0, b.v | 0)), q = b.q ? 1 : 0;
    const f = Object.entries(b.f && typeof b.f === 'object' ? b.f : {}).filter(([k, n]) => /^[a-z][a-z0-9_]{0,39}$/.test(k) && n > 0).slice(0, 40).map(([k, n]) => [k, Math.min(k.startsWith('rd_') ? 50000 : 50, n | 0)]);   // rd_＝瀏覽器讀了幾筆資料庫
    if (!v && !f.length) return json({ ok: true });
    const tok = await saToken(env);
    let uid = '', name = '';
    if (typeof b.t === 'string' && b.t.split('.').length === 3) {
      try { const id = uidOfToken(b.t); const u = await fsUser(b.t, id); if (u && u.status === 'approved') { uid = id; name = u.realName || ''; } } catch (e) {}
      if (uid && uid === await devUid(tok)) {   // 開發者自己的使用不算，但讀了多少資料庫要算（才找得到誰讀最多）
        const rf = f.filter(([k]) => k.startsWith('rd_')); if (!rf.length) return json({ ok: true, skip: 'dev' });
        const r = await writeUsage(tok, { pg, v: 0, q: 0, f: rf, uid, name }); return json({ ok: r.ok });
      }
    }
    const r = await writeUsage(tok, { pg, v, q, f, uid, name });
    return json({ ok: r.ok });
  } catch (e) { return json({ ok: false }, 500); }
}
// 寫一筆使用紀錄：pg 頁面、v 開啟次數、q 當天第一次、f [[功能, 次數]]、uid／name（可省略＝匿名）、lu＝LINE 使用者（只算人數）
async function writeUsage(tok, { pg, v = 0, q = 0, f = [], uid = '', name = '', lu = '' }) {
  const now = Date.now(), tw = new Date(now + 8 * 3600e3), day = tw.toISOString().slice(0, 10).replace(/-/g, ''), hh = 'h' + String(tw.getUTCHours()).padStart(2, '0');
  const acts = f.reduce((a, [k, n]) => a + (k.startsWith('rd_') ? 0 : n), 0);   // 讀取筆數不算「操作次數」
  const inc = (path, n) => ({ fieldPath: path, increment: { integerValue: String(n) } });
  const T = [];
  if (v) T.push(inc(fq('p', pg), v)); if (v || pg === 'line') T.push(inc(fq('h', hh), v || acts)); if (q) T.push(inc(fq('q', pg), 1));
  f.forEach(([k, n]) => T.push(inc(fq('f', k), n)));
  if (lu) T.push(inc(fq('lu', lu), 1));
  if (!uid) { if (v) T.push(inc(fq('anon', pg), v)); }
  else { if (v) T.push(inc(fq('u', uid, 'v'), v), inc(fq('u', uid, 'pg_' + pg), v)); if (acts) T.push(inc(fq('u', uid, 'a'), acts)); f.forEach(([k, n]) => T.push(inc(fq('u', uid, k), n))); }
  const D = n => `projects/${PROJECT_ID}/databases/(default)/documents/${n}`;
  const writes = [{ transform: { document: D('usage_daily/' + day), fieldTransforms: T } }];
  if (uid) writes.push({ update: { name: D('usage_meta/last'), fields: { n: { mapValue: { fields: { [uid]: { stringValue: name } } } } } }, updateMask: { fieldPaths: [fq('n', uid)] },
    updateTransforms: [{ fieldPath: fq('t', uid), maximum: { integerValue: String(now) } }] });
  const go = () => fetch(`${FS}:commit`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  let r = await go();
  if (!r.ok && (r.status === 409 || r.status === 503 || r.status === 429)) { await new Promise(x => setTimeout(x, 400)); r = await go(); }
  return r;
}
// LINE 官方帳號：選單四格（送出文字）、切換分頁、加好友／封鎖 → 記到使用分析（頁面＝line）
const LINE_MENU_F = { '認識醫護團': 'menu_about', '認識醫療團': 'menu_about', '衛教須知': 'menu_edu', '醫護足跡': 'menu_journey', '全民醫護證': 'menu_guardian' };
async function lineUsage(env, events) {
  const tok = await saToken(env), dev = await devUid(tok);
  for (const ev of events) {
    let k = '';
    if (ev.type === 'message' && ev.message?.type === 'text') k = LINE_MENU_F[String(ev.message.text).trim()] || '';
    else if (ev.type === 'postback' && /^tab=(member|public)$/.test(ev.postback?.data || '')) k = 'menu_tab_' + ev.postback.data.slice(4);
    else if (ev.type === 'follow') k = 'line_follow';
    else if (ev.type === 'unfollow') k = 'line_unfollow';
    if (!k) continue;
    const lu = ev.source?.userId || ''; if (lu && lu === dev) continue;   // 開發者自己不算
    let uid = '', name = '';
    if (lu && /^U[0-9a-f]{32}$/.test(lu)) { try { const d = await fsGet(tok, 'users/' + lu); const u = d ? fobj(d.fields) : null; if (u && u.status === 'approved') { uid = lu; name = u.realName || ''; } } catch (e) {} }
    const f = [[k, 1]]; if (k === 'line_follow' || k === 'line_unfollow') f.push([k + (uid ? '_m' : '_p'), 1]);   // _m＝團員、_p＝民眾
    await writeUsage(tok, { pg: 'line', f, uid, name, lu: /^U[0-9a-f]{32}$/.test(lu) ? lu : '' });
  }
}
async function usageStatsRoute(req, env, json) {
  try {
    const { idToken, days } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken); const me = await fsUser(idToken, uid);
    const tok = await saToken(env);
    if (!me || uid !== await devUid(tok)) return json({ error: '只有開發者可以看使用分析' }, 403);
    const N = Math.min(92, Math.max(1, days | 0 || 30)), ids = [];
    for (let i = 0; i < N; i++) ids.push(new Date(Date.now() + 8 * 3600e3 - i * 864e5).toISOString().slice(0, 10).replace(/-/g, ''));
    const D = n => `projects/${PROJECT_ID}/databases/(default)/documents/${n}`;
    const bg = await fetch(`${FS}:batchGet`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: [...ids.map(d => D('usage_daily/' + d)), D('usage_meta/last')] }) });
    if (!bg.ok) throw new Error('read ' + bg.status);
    const out = {}; let last = {};
    for (const x of await bg.json()) { if (!x.found) continue; const id = x.found.name.split('/').pop(), o = fobj(x.found.fields); if (id === 'last') last = o; else out[id] = o; }
    const [usersL, eduA, evL] = await Promise.all([memo('users', 600e3, () => fsList(tok, 'users')), fsGet(tok, 'stats/edu'), memo('events', 30e3, () => fsList(tok, 'events'))]);
    const users = usersL.filter(u => u.status === 'approved' && u.id !== uid).map(u => ({ id: u.id, name: u.realName || u.displayName || '' }));
    const trips = evL.filter(e => e.schedPublic || e.schedAt || e.askGroups).map(e => ({ id: e.id, title: e.title || '', at: e.createdAt || 0 }));
    return json({ ok: true, days: ids, daily: out, last, users, edu: eduA ? fobj(eduA.fields) : {}, trips });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

// 進香每日總表（只有開發者）：每天排班人數、到勤、組長檢查完成、救護紀錄件數、器材出入庫
async function usageTripRoute(req, env, json) {
  try {
    const { idToken, eid } = await req.json();
    if (!idToken || !/^[A-Za-z0-9_-]{1,64}$/.test(eid || '')) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken); const me = await fsUser(idToken, uid); const tok = await saToken(env);
    if (!me || uid !== await devUid(tok)) return json({ error: '只有開發者可以看' }, 403);
    const dr = await fsGet(tok, `events/${eid}/admin/draw`); const sc = dr ? (fobj(dr.fields).sched || {}) : {}, days = sc.days || {};
    const ds = Object.keys(days).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!ds.length) return json({ ok: true, days: [] });
    const D = n => `projects/${PROJECT_ID}/databases/(default)/documents/${n}`;
    const leadNames = []; ds.forEach(d => (days[d] || []).forEach(t => leadNames.push(D(`events/${eid}/admin/lead_${d}_${encodeURIComponent(t.l)}`))));
    const leads = {};
    for (let i = 0; i < leadNames.length; i += 100) {
      const r = await fetch(`${FS}:batchGet`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: leadNames.slice(i, i + 100) }) });
      if (r.ok) for (const x of await r.json()) if (x.found) { const o = fobj(x.found.fields); leads[o.d + '|' + o.team] = o; } }
    // 救護紀錄、倉庫紀錄：只讀進香期間（台灣時間 ds[0] 前一天 ～ 最後一天）
    const t0 = Date.parse(isoAddW(ds[0], -1) + 'T00:00:00+08:00'), t1 = Date.parse(ds[ds.length - 1] + 'T23:59:59+08:00');
    const q = (coll, field, isTs, sel) => fetch(`${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: coll }], select: { fields: sel.map(f => ({ fieldPath: f })) },
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: isTs ? { timestampValue: new Date(t0).toISOString() } : { integerValue: String(t0) } } },
        { fieldFilter: { field: { fieldPath: field }, op: 'LESS_THAN_OR_EQUAL', value: isTs ? { timestampValue: new Date(t1).toISOString() } : { integerValue: String(t1) } } }] } } } }) })
      .then(r => r.ok ? r.json() : []).then(L => L.filter(x => x.document).map(x => fobj(x.document.fields)));
    const [recs, logs] = await Promise.all([q('medical_records', 'timestamp', true, ['timestamp']), q('warehouse_logs', 'timestamp', false, ['timestamp', 'type', 'qty'])]);
    const dayOf = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
    const rc = {}, out = {}, inn = {}; recs.forEach(x => { const k = dayOf(x.timestamp); rc[k] = (rc[k] || 0) + 1; });
    logs.forEach(x => { const k = dayOf(x.timestamp), n = +x.qty || 1; if (x.type === '出庫') out[k] = (out[k] || 0) + n; else if (x.type === '入庫') inn[k] = (inn[k] || 0) + n; });
    const F6 = ['attAt', 'bffAt', 'mealAt', 'eqAt', 'dressAt', 'chargeAt'];
    const rows = ds.map(d => { const ts = (days[d] || []).filter(t => (t.m || []).length); let sched = 0, att = 0, attTeams = 0, full = 0, part = 0;
      ts.forEach(t => { sched += t.m.length; const c = leads[d + '|' + t.l] || {}; if (c.attAt) { attTeams++; att += Object.values(c.att || {}).filter(Boolean).length; }
        const n = F6.filter(f => c[f]).length; if (n === 6) full++; else if (n) part++; });
      const I = (sc.info || {})[d] || {};
      return { d, tag: I.tag || '', place: I.place || '', teams: ts.length, sched, att, attTeams, full, part, rec: rc[d] || 0, out: out[d] || 0, in: inn[d] || 0 }; });
    return json({ ok: true, days: rows, before: { rec: rc[isoAddW(ds[0], -1)] || 0, out: out[isoAddW(ds[0], -1)] || 0 } });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

// 資料庫用量（只有開發者）：從 Google Cloud Monitoring 讀 Firestore 讀取／寫入／刪除次數
// 服務帳戶要有「Monitoring 檢視者」(roles/monitoring.viewer) 角色才讀得到
let monTok = null;
async function monitorToken(env) {
  if (monTok && monTok.exp > Date.now() + 60000) return monTok.t;
  const sa = JSON.parse(env.SERVICE_ACCOUNT), now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt(sa, { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/monitoring.read', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt });
  const j = await r.json(); if (!j.access_token) throw new Error('monitoring token failed');
  monTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return monTok.t;
}
const laDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
// 開發者：伺服器自己記的用量（每小時一格）＋定位狀態
async function devOnly(req, env) {
  const body = await req.json(); const { idToken } = body; if (!idToken) throw Object.assign(new Error('missing'), { code: 400 });
  const uid = uidOfToken(idToken), me = await fsUser(idToken, uid), tok = await saToken(env);
  if (!me || uid !== await devUid(tok)) throw Object.assign(new Error('只有開發者可以看'), { code: 403 });
  return body;
}
async function usageMeterRoute(req, env, json) {
  try {
    const { days } = await devOnly(req, env); if (!env.LOC) return json({ error: '定位（LocHub）尚未部署' }, 501);
    const hub = env.LOC.get(env.LOC.idFromName('main'));
    { const b = MTR.b; MTR.b = {}; MTR.at = Date.now(); if (Object.keys(b).length) await hub.meterAdd(b); }   // 這台伺服器手上還沒存的先存
    const d = Math.min(Math.max(+days || 8, 1), 35), from = hourKey(Date.now() - d * 864e5);
    const [m, st] = await Promise.all([hub.meterGet(from), hub.admin('state', {})]);
    const now = Date.now();
    const loc = { devices: st.trackers.length, duty: st.trackers.filter(t => t.duty).length,
      live: st.trackers.filter(t => now - Math.max(t.last || 0, t.ping || 0) < 5 * 60e3).length,
      watchToday: st.watchers.filter(w => w.day === new Date(now + 8 * 3600e3).toISOString().slice(0, 10)).length,
      watchers: st.watchers.slice(0, 60).map(w => ({ name: w.name, last: w.last, n: w.n, day: w.day })),
      trackers: st.trackers.map(t => ({ name: t.name, kind: t.kind, duty: t.duty, last: Math.max(t.last || 0, t.ping || 0) })) };
    return json({ ok: true, m, loc, now });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e.code || 500); }
}
// 開發者：檢查官方帳號 webhook（LINE 那邊設定的網址、有沒有開、LINE 實際打過來的結果）
async function lineCheckRoute(req, env, json) {
  try {
    await devOnly(req, env); if (!env.LINE_BOT_TOKEN) return json({ ok: true, noToken: true });
    const H = { Authorization: 'Bearer ' + env.LINE_BOT_TOKEN, 'Content-Type': 'application/json' };
    const info = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers: H }).then(async r => ({ st: r.status, ...(await r.json().catch(() => ({}))) }));
    const test = await fetch('https://api.line.me/v2/bot/channel/webhook/test', { method: 'POST', headers: H, body: '{}' }).then(async r => ({ st: r.status, ...(await r.json().catch(() => ({}))) }));
    const bot = await fetch('https://api.line.me/v2/bot/info', { headers: H }).then(async r => ({ st: r.status, ...(await r.json().catch(() => ({}))) }));
    return json({ ok: true, info, test, bot: { st: bot.st, name: bot.displayName, id: bot.basicId, mode: bot.chatMode, read: bot.markAsReadMode } });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e.code || 500); }
}
// 開發者：官方帳號好友數（LINE 官方統計，每天的數字隔天才有）＋團員裡有幾個是好友
async function usageLineRoute(req, env, json) {
  try {
    await devOnly(req, env); if (!env.LINE_BOT_TOKEN) return json({ error: '沒有設定 LINE_BOT_TOKEN' }, 500);
    const H = { Authorization: 'Bearer ' + env.LINE_BOT_TOKEN };
    const out = await memo('lineFollowers', 3600e3, async () => {
      const days = Array.from({ length: 8 }, (_, i) => new Date(Date.now() + 9 * 3600e3 - (i + 1) * 864e5).toISOString().slice(0, 10).replace(/-/g, ''));   // LINE 用日本時間
      const ins = await Promise.all(days.map(d => fetch('https://api.line.me/v2/bot/insight/followers?date=' + d, { headers: H }).then(r => r.json()).then(j => ({ d, ...j })).catch(() => ({ d, status: 'error' }))));
      const tok = await saToken(env), users = (await memo('users', 600e3, () => fsList(tok, 'users'))).filter(u => u.status === 'approved' && /^U[0-9a-f]{32}$/.test(u.id));
      let friends = 0, blocked = 0;
      for (let i = 0; i < users.length; i += 10) {   // 一次問 10 個：是好友會回個人資料，沒加或封鎖回 404
        const R = await Promise.all(users.slice(i, i + 10).map(u => fetch('https://api.line.me/v2/bot/profile/' + u.id, { headers: H }).then(r => r.status).catch(() => 0)));
        R.forEach(st => { if (st === 200) friends++; else if (st === 404) blocked++; });
      }
      return { ins, members: users.length, memberFriends: friends, memberNot: blocked, at: Date.now() };
    });
    return json({ ok: true, ...out });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e.code || 500); }
}
// 開發者：Cloudflare 官方每日用量（GraphQL Analytics；要設 Secret CF_API_TOKEN 和變數 CF_ACCOUNT_ID）
async function usageCfRoute(req, env, json) {
  try {
    await devOnly(req, env);
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return json({ ok: true, needSetup: true });
    const end = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const gql = async (ds, fields) => {
      const query = `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){x:${ds}(limit:2000,filter:{date_geq:$s,date_leq:$e}){${fields} dimensions{date}}}}}`;
      const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, s: start, e: end } }) });
      const j = await r.json().catch(() => ({}));
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
      const rows = (((j.data || {}).viewer || {}).accounts || [])[0]; if (!rows) throw new Error('查不到帳號（CF_ACCOUNT_ID 對嗎？權杖有 Account Analytics 讀取權限嗎？）');
      const out = {}; for (const x of rows.x || []) { const d = x.dimensions.date, o = out[d] || (out[d] = {}); for (const [k, v] of Object.entries(x.sum || {})) o[k] = (o[k] || 0) + (+v || 0); } return out;
    };
    const safe = async (ds, f) => { try { return { ok: await gql(ds, f) }; } catch (e) { return { err: String(e.message || e).slice(0, 200) }; } };
    const [w, dr, dp] = await Promise.all([
      safe('workersInvocationsAdaptive', 'sum{requests errors subrequests}'),
      safe('durableObjectsInvocationsAdaptiveGroups', 'sum{requests}'),
      safe('durableObjectsPeriodicGroups', 'sum{rowsRead rowsWritten}')]);
    return json({ ok: true, workers: w, doReq: dr, doRows: dp });
  } catch (e) { return json({ error: String((e && e.message) || e) }, e.code || 500); }
}
async function usageQuotaRoute(req, env, json) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken); const me = await fsUser(idToken, uid); const tok = await saToken(env);
    if (!me || uid !== await devUid(tok)) return json({ error: '只有開發者可以看' }, 403);
    const sa = JSON.parse(env.SERVICE_ACCOUNT), mt = await monitorToken(env);
    const end = new Date(), start = new Date(Date.now() - 8 * 864e5);
    const one = async m => {
      const q = new URLSearchParams({ filter: `metric.type="firestore.googleapis.com/document/${m}"`, 'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
        'aggregation.alignmentPeriod': '3600s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM' });
      const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries?${q}`, { headers: { Authorization: 'Bearer ' + mt } });
      if (!r.ok) { const t = await r.text(); throw Object.assign(new Error(t.slice(0, 300)), { status: r.status }); }
      const pts = ((await r.json()).timeSeries || []).flatMap(ts => ts.points || []);
      const byDay = {}, byHour = {};
      pts.forEach(p => { const t = Date.parse(p.interval.endTime) - 1, v = +(p.value.int64Value || p.value.doubleValue || 0), d = laDay(t);
        byDay[d] = (byDay[d] || 0) + v; if (d === laDay(Date.now())) { const h = new Date(t + 8 * 3600e3).getUTCHours(); byHour[h] = (byHour[h] || 0) + v; } });
      return { byDay, byHour };
    };
    let reads, writes, deletes;
    try { [reads, writes, deletes] = await Promise.all(['read_count', 'write_count', 'delete_count'].map(one)); }
    catch (e) { if (e.status === 403 || e.status === 401) return json({ ok: false, needRole: true, sa: sa.client_email, project: PROJECT_ID }); throw e; }
    // 下一次歸零：美西時間半夜（台灣下午 3 點或 4 點）
    let nx = Date.now(); const today = laDay(nx); while (laDay(nx) === today) nx += 600e3;
    return json({ ok: true, today, resetAt: nx, limit: { reads: 50000, writes: 20000, deletes: 20000 }, reads, writes, deletes });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

// 全民醫護證：把自己的醫護證圖片存起來，給 LINE 分享用（圖片訊息需要網址）
async function guardianImgRoute(req, env, json) {
  try {
    const { accessToken, data } = await req.json();
    if (!accessToken || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) return json({ error: 'missing' }, 400);
    if (data.length > 950000) return json({ error: '圖片太大' }, 413);
    const [v, p] = await Promise.all([
      fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken)),
      fetch('https://api.line.me/v2/profile', { headers: { Authorization: 'Bearer ' + accessToken } })]);
    if (!v.ok || !p.ok) return json({ error: 'invalid token' }, 401);
    const info = await v.json(); if (String(info.client_id) !== LINE_CHANNEL_ID) return json({ error: 'wrong channel' }, 401);
    const { userId } = await p.json(); if (!/^U[0-9a-f]{32}$/.test(userId || '')) return json({ error: 'no user' }, 401);
    const tok = await saToken(env), H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const g = await fsGet(tok, `guardian/${userId}`); if (!g) return json({ error: '請先領取醫護證' }, 400);
    const old = fobj(g.fields).img || '';
    const id = 'g' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
    const w = await fetch(`${FS}/guardian_img/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { data: { stringValue: data }, at: { integerValue: String(Date.now()) } } }) });
    if (!w.ok) return json({ error: 'save ' + w.status }, 500);
    await fetch(`${FS}/guardian/${userId}?updateMask.fieldPaths=img`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { img: { stringValue: id } } }) });
    if (old && /^g[a-z0-9]{6,30}$/.test(old)) fetch(`${FS}/guardian_img/${old}`, { method: 'DELETE', headers: H }).catch(() => {});   // 舊的刪掉
    return json({ ok: true, url: `${new URL(req.url).origin}/gc/${id}.jpg` });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

// ===== 團員功能開關（完整管理員一鍵）：關閉時，一般團員（不是任何管理員）的 LINE 選單變回民眾版，團員專區只顯示會員卡 =====
const isRegular = u => !!u && !(u.role === 'admin' || u.adminMember || u.adminWarehouse || u.adminRecord);
async function memberGate(env) {
  return memo('gate', 30e3, async () => { const d = await fsGet(await saToken(env), 'meta/gate'); return d ? fobj(d.fields).memberOpen !== false : true; });
}
async function gateSetRoute(req, env, json) {
  try {
    const { idToken, open } = await req.json();
    if (!idToken || typeof open !== 'boolean') return json({ error: 'missing' }, 400);
    const uid = uidOfToken(idToken), me = await fsUser(idToken, uid);
    if (!(await fullAdmin(me, idToken, env))) return json({ error: '只有完整管理員或開發者可以切換' }, 403);
    const tok = await saToken(env);
    const w = await fetch(`${FS}/meta/gate`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { memberOpen: { booleanValue: open }, at: { integerValue: String(Date.now()) }, by: { stringValue: uid } } }) });
    if (!w.ok) return json({ error: 'save ' + w.status }, 500);
    MEMO.delete('gate');
    // 一般團員的選單一起換
    const dev = await devUid(tok);
    const ids = (await fsList(tok, 'users')).filter(u => u.status === 'approved' && isRegular(u) && !(u.earlyAccess === true && !open) && u.id !== dev && /^U[0-9a-f]{32}$/.test(u.id)).map(u => u.id);
    let menuId = '';
    if (open) { const a = await lineApi(env, '/v2/bot/richmenu/alias/' + MENUS.member.alias); if (!a.ok) return json({ ok: true, open, users: ids.length, warn: '選單還沒發佈，請先按「發佈 LINE 圖文選單」' }); menuId = (await a.json()).richMenuId; }
    let fail = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const userIds = ids.slice(i, i + 500);
      const r = open ? await lineApi(env, '/v2/bot/richmenu/bulk/link', { method: 'POST', type: 'application/json', body: JSON.stringify({ richMenuId: menuId, userIds }) })
                     : await lineApi(env, '/v2/bot/richmenu/bulk/unlink', { method: 'POST', type: 'application/json', body: JSON.stringify({ userIds }) });
      if (!r.ok) fail += userIds.length;
    }
    return json({ ok: true, open, users: ids.length, fail });
  } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
}

// ===== 團員定位（OwnTracks → 即時地圖）=====
// 位置不放 Firestore（每 30 秒一筆會超過免費額度），放在 Durable Object「LocHub」（只有一個實體 main）
// 小組長／指揮車／物資車的手機裝 OwnTracks（HTTP 模式），POST 到 /owntracks，用 HTTP Basic 帳密（帳號＝裝置 ID）
// 誰看得到地圖：完整管理員、開發者、名單上的查看者、綁定在某台裝置的團員
const LOC_TTL = 12 * 3600e3;          // 超過 12 小時沒更新就不顯示
const LOC_SESS = 60 * 60e3;   // 查看權限暫存 60 分鐘（每人每小時才查一次 Firestore）
const TRK_KEEP = 30 * 86400e3;       // 軌跡保留 30 天（只存值勤中的點）           // 查看權限暫存 10 分鐘，地圖每 15 秒更新時不用每次查 Firestore
const OT_FRIENDS = true;
const LOC_OPEN = false;                // false＝只有管理員、今天有排班的人、後台加入的人、綁定裝置的人看得到地圖              // OwnTracks App 裡也顯示其他裝置（App 的「朋友」）
const LOC_KINDS = ['小組長', '指揮車', '物資車', '其他'];
const LOC_TID = { 小組長: 'L', 指揮車: 'C', 物資車: 'S', 其他: 'X' };   // OwnTracks 圖示上的 2 個字（用英數字比較保險）
const locTid = (kind, id) => LOC_TID[kind] + id.slice(-1).toUpperCase();
const locHub = env => { const st = env.LOC.get(env.LOC.idFromName('main'));   // 每次呼叫 DO 都記一筆（依方法）
  return new Proxy(st, { get(t, p) { const v = t[p]; return typeof p === 'string' && typeof v === 'function' ? (...a) => { mAdd('d', p); return Reflect.apply(v, t, a); } : v; } }); };   // 不能用 v.apply：DO 的 RPC 物件會把 .apply 當成遠端方法
const numOr = v => (typeof v === 'number' && isFinite(v)) ? v : null;
async function sha256hex(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function randStr(n, abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') { const r = crypto.getRandomValues(new Uint8Array(n)); return [...r].map(x => abc[x % abc.length]).join(''); }
const picOk = u => { try { const x = new URL(String(u || '')); return x.protocol === 'https:' && /(^|\.)line-scdn\.net$/.test(x.hostname) ? x.href.slice(0, 300) : ''; } catch (e) { return ''; } };
// 排班表：今天每個人在哪一組（地圖名字前面加組別）、誰是小組長（每組第一個人）
async function locTeams(env) {
  return memo('locTeams', 300e3, async () => {
    // workers.dev 不能用 Cache API → 存在唯一的 LocHub 記憶體裡，所有伺服器共用，10 分鐘才重讀一次 Firestore
    let hub = null; try { if (env.LOC) { hub = locHub(env); const c = await hub.teamsGet(); if (c) return c; } } catch (e) {}
    const out = await locTeamsLoad(env);
    try { if (hub) await hub.teamsSet(out); } catch (e) {}
    return out;
  });
}
async function locTeamsLoad(env) {
  return (async () => {
    const tok = await saToken(env), today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const evs = (await memo('events', 30e3, () => fsList(tok, 'events'))).filter(e => e.schedPublic).sort((a, b) => (b.schedPublicAt || 0) - (a.schedPublicAt || 0));
    const out = { today: {}, leads: {}, on: {}, leadNow: {} }, best = {};   // on：今天有排班；leadNow：今天是小組長   // today：今天有排班用今天，沒有就用最接近的排班日（之後最近的一天，都過了就用最後一天）
    const score = d => d === today ? 0 : d > today ? 1 + (Date.parse(d) - Date.parse(today)) / 864e5 : 1e6 + (Date.parse(today) - Date.parse(d)) / 864e5;
    for (const e of evs) { const dr = await memo('draw:' + e.id, 20e3, () => fsGet(tok, `events/${e.id}/admin/draw`)); if (!dr) continue;
      const D = (fobj(dr.fields).sched || {}).days || {};
      Object.keys(D).sort().forEach(d => (D[d] || []).forEach(t => { const m = (t.m || []).filter(Boolean), sc = score(d);
        if (m[0] && (!out.leads[m[0]] || d <= today)) out.leads[m[0]] = t.l || '';
        if (d === today) { m.forEach(k => { out.on[k] = t.l || ''; }); if (m[0]) out.leadNow[m[0]] = t.l || ''; }
        m.forEach(k => { if (!(k in best) || sc < best[k]) { best[k] = sc; out.today[k] = t.l || ''; } }); }));
      if (Object.keys(D).length) break; }
    return out;
  })();
}
// 今天的角色：sc＝今天有排班（可看地圖）、ld＝今天是小組長（可自己產生 QR）
async function locRole(idToken, env) {
  try { const M = await locMe(idToken, env); if (!M) return { ld: false, sc: false }; const T = await locTeams(env);
    return { ld: M.rkey in (T.leadNow || {}), sc: M.rkey in (T.on || {}), me: M }; } catch (e) { return { ld: false, sc: false }; }
}
// 性別只從身分證第二碼推算（1 男 2 女），不存也不回傳身分證
const hav2 = (a, b, c, d) => { const R = 6371e3, r = x => x * Math.PI / 180, x = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const sexOf = c => { const d = String(c || '').toUpperCase()[1]; return d === '1' ? 'm' : d === '2' ? 'f' : ''; };
// 自己的資料：姓名（名冊）、大頭貼、名冊 key
async function locMe(idToken, env) {
  const uid = uidOfToken(idToken);
  const r = await fetch(`${FS}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: 'Bearer ' + idToken } });
  if (!r.ok) throw Object.assign(new Error('not allowed'), { code: 401 });
  const u = fobj((await r.json()).fields); if (u.status !== 'approved') return null;
  let rkey = '', name = u.realName || '';
  let sex = '';
  if (u.rosterId) { const ro = await fsGet(await saToken(env), `member_roster/${encodeURIComponent(u.rosterId)}`); if (ro) { const f = fobj(ro.fields); rkey = normName(f.name); name = f.name || name; sex = sexOf(f.idCard); } }
  return { uid, u, rkey: rkey || normName(name), name: normName(name), pic: u.pictureUrl || '', sex };
}
const cleanTxt = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);

export class LocHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.T = new Map(); this.L = new Map(); this.V = new Map(); this.P = new Map(); this.W = new Map();   // W：誰在看地圖   // 裝置、最新位置、查看者
    this.sql = ctx.storage.sql;   // 軌跡用 SQLite（每點一列）
    this.MT = {}; this.mtAt = Date.now(); this.MC = new Map();   // 自己的用量（列讀寫）
    this.q('CREATE TABLE IF NOT EXISTS trk (id TEXT, tst INTEGER, lat REAL, lon REAL, acc INTEGER)');
    this.q('CREATE INDEX IF NOT EXISTS trk_i ON trk(id, tst)');
    this.q('DROP INDEX IF EXISTS trk_t');   // 多一個索引＝每筆軌跡多寫一列，改用 (id, tst) 逐台清
    this.pruned = 0;
    ctx.blockConcurrencyWhile(async () => {   // 只讀需要的前綴（用量紀錄 m: 不在這裡讀）
      const M = { 't:': this.T, 'l:': this.L, 'v:': this.V, 'w:': this.W };
      for (const pre of Object.keys(M)) { const L = await ctx.storage.list({ prefix: pre }); this.mt('dr', 'kv 開機', L.size || 0); for (const [k, v] of L) M[pre].set(k.slice(2), v); }
      this.pruned = (await ctx.storage.get('pruned')) || 0; this.mt('dr', 'kv 開機', 1); this.mt('do', '喚醒', 1);
    });
  }
  mt(cat, key, n = 1) { if (!n) return; const h = hourKey(), b = this.MT[h] || (this.MT[h] = {}), c = b[cat] || (b[cat] = {}); c[key] = (c[key] || 0) + n; }
  q(sql, ...a) { const c = this.sql.exec(sql, ...a), rows = c.toArray(), k = sql.trim().split(/\s+/).slice(0, 1)[0].toUpperCase() + ' 軌跡';
    this.mt('dr', k, c.rowsRead || 0); this.mt('dw', k, c.rowsWritten || 0); return rows; }
  kput(k, v) { this.mt('dw', 'kv ' + k.slice(0, 1), 1); return this.ctx.storage.put(k, v); }
  kdel(k) { this.mt('dw', 'kv 刪除', Array.isArray(k) ? k.length : 1); return this.ctx.storage.delete(k); }
  // 存用量：Worker 送來的＋自己的，合併進每小時一格（m:YYYYMMDDHH）
  async meterAdd(b) {
    const own = this.MT; this.MT = {}; this.mtAt = Date.now();
    const hs = new Set([...Object.keys(b || {}), ...Object.keys(own)]);
    for (const h of hs) {
      let cur = this.MC.get(h); if (!cur) { cur = (await this.ctx.storage.get('m:' + h)) || {}; this.MC.set(h, cur); this.mt('dr', '存用量', 1); }
      for (const src of [b && b[h], own[h]]) if (src) for (const [cat, o] of Object.entries(src)) { const c = cur[cat] || (cur[cat] = {}); for (const [k, n] of Object.entries(o)) c[k] = (c[k] || 0) + n; }
      await this.kput('m:' + h, cur);
    }
    if (this.MC.size > 4) for (const k of [...this.MC.keys()].sort().slice(0, this.MC.size - 4)) this.MC.delete(k);
    const day = new Date().toISOString().slice(0, 10);
    if (this.mPruned !== day) { this.mPruned = day; const old = await this.ctx.storage.list({ prefix: 'm:', end: 'm:' + hourKey(Date.now() - 40 * 864e5) }); if (old.size) await this.ctx.storage.delete([...old.keys()]); }
    return { ok: true };
  }
  async meterGet(fromH) {
    const out = {}, LS = await this.ctx.storage.list({ prefix: 'm:', start: 'm:' + fromH }); this.mt('dr', '讀用量', LS.size || 0); for (const [k, v] of LS) out[k.slice(2)] = v;
    for (const [h, o] of Object.entries(this.MT)) { const cur = out[h] || (out[h] = {}); for (const [cat, x] of Object.entries(o)) { const c = cur[cat] || (cur[cat] = {}); for (const [k, n] of Object.entries(x)) c[k] = (c[k] || 0) + n; } }
    return out;
  }
  // OwnTracks 上傳：帳密對了才收；回傳其他裝置的位置給 App 顯示
  async pub(user, pass, m) {
    const t = this.T.get(user);
    if (!t || !pass || t.h !== await sha256hex(pass)) {   // 記下被拒絕的手機（只放記憶體），管理面板看得到原因
      (this.R || (this.R = new Map())).set(user, { why: !t ? '找不到這台（已刪除）' : '密碼不對（換過密碼）', at: Date.now(), name: t ? t.name : '' });
      return { auth: false }; }
    const now = Date.now(), duty = t.duty !== false; this.mt('loc', '手機上傳', 1);
    if (now - this.mtAt > 300e3) this.meterAdd({}).catch(() => {});
    this.P.set(user, now);   // 最後連線（退勤時也會偶爾連線，只放記憶體）
    if (m && m._type === 'location' && numOr(m.m) !== null && t.mode !== m.m) { t.mode = m.m; t.seen = now; await this.kput('t:' + user, t); }
    if (duty && m && m._type === 'location' && numOr(m.lat) !== null && numOr(m.lon) !== null && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180) {
      const tst = numOr(m.tst) ? m.tst * 1000 : now;
      const l = { lat: m.lat, lon: m.lon, acc: numOr(m.acc), batt: numOr(m.batt), vel: numOr(m.vel), cog: numOr(m.cog), tst: Math.min(tst, now), at: now };
      const old = this.L.get(user);
      if (!old || l.tst >= old.tst) { l.sv = old && now - (old.sv || 0) < 120e3 ? old.sv : now; this.L.set(user, l); try { await this.rallyTick(user, l); } catch (e) {} if (l.sv === now) await this.kput('l:' + user, l); }   // 最新位置 2 分鐘才寫一次儲存（記憶體一直是最新的）   // 離線補傳的舊位置不蓋掉新的
      const ls = (this.LS || (this.LS = new Map())).get(user), dm = ls ? Math.hypot((l.lat - ls.lat) * 111320, (l.lon - ls.lon) * 111320 * Math.cos(l.lat * Math.PI / 180)) : 1e9;
      // 軌跡只在移動超過 15 公尺、或距上一點超過 2 分鐘才存（站著不動不用一直寫，省寫入列數）
      if ((!old || l.tst !== old.tst) && (!ls || dm > 15 || Math.abs(l.tst - ls.tst) > 120e3)) { this.LS.set(user, { lat: l.lat, lon: l.lon, tst: l.tst }); this.mt('loc', '軌跡點', 1); this.q('INSERT INTO trk (id, tst, lat, lon, acc) VALUES (?, ?, ?, ?, ?)', user, l.tst, l.lat, l.lon, Math.round(l.acc || 0)); }   // 補傳的舊點也記進軌跡
      if (now - this.pruned > 6 * 3600e3) { this.pruned = now; this.kput('pruned', now); for (const id of this.T.keys()) this.q('DELETE FROM trk WHERE id = ? AND tst < ?', id, now - TRK_KEEP); }
    }
    const out = [];
    // 網站切換值勤／退勤：手機回報的模式不對就下指令改（值勤 Move=2、退勤 Significant=1；退勤也要偶爾傳，才收得到「開始值勤」）
    const want = duty ? 2 : 1;
    if (t.mode !== want && (!t.cmdAt || now - t.cmdAt > 60e3 || t.cmdWant !== want)) {
      out.push({ _type: 'cmd', action: 'setConfiguration', configuration: { _type: 'configuration', monitoring: want } });
      t.cmdAt = now; t.cmdWant = want; await this.kput('t:' + user, t);
    }
    if (OT_FRIENDS && duty) for (const [id, l] of this.L) {
      const f = this.T.get(id); if (id === user || !f || f.duty === false || now - l.at > LOC_TTL) continue;
      const topic = 'owntracks/bst/' + id;
      out.push({ _type: 'card', name: f.name, tid: f.tid, topic }, { _type: 'location', lat: l.lat, lon: l.lon, acc: Math.round(l.acc || 0), tst: Math.floor(l.tst / 1000), tid: f.tid, topic });
    }
    return { auth: true, out };
  }
  // 小組長自己產生：每人一台（綁定自己），已經有就回同一組帳密（QR 一樣，不會讓舊設定失效）
  async selfGet(uid, a) {
    const st = this.ctx.storage;
    let id = ([...this.T.entries()].find(([, t]) => t.uid === uid && t.self) || [])[0];
    if (id) { const t = this.T.get(id), pic = picOk(a.pic), rkey = cleanTxt(a.rkey, 20);
      const sx = ['m', 'f'].includes(a.sex) ? a.sex : '';
      if ((pic && t.pic !== pic) || (rkey && t.rkey !== rkey) || (sx && t.sex !== sx) || !t.pw) { if (pic) t.pic = pic; if (rkey) t.rkey = rkey; if (sx) t.sex = sx;
        if (!t.pw) { t.pw = randStr(24); t.h = await sha256hex(t.pw); } await this.kput('t:' + id, t); }
      await this.onDuty(id); return { ok: true, id, pw: t.pw, tid: t.tid, name: t.name, fresh: false, used: this.used(id) }; }
    const name = cleanTxt(a.name, 20) || '小組長';
    do { id = 'bst' + randStr(5, 'abcdefghijkmnpqrstuvwxyz23456789'); } while (this.T.has(id));
    const pw = randStr(24), t = { name, kind: '小組長', uid, uname: name, pic: picOk(a.pic), rkey: cleanTxt(a.rkey, 20), sex: ['m', 'f'].includes(a.sex) ? a.sex : '', self: true, tid: locTid('小組長', id), h: await sha256hex(pw), pw, at: Date.now(), by: uid };
    this.T.set(id, t); await this.kput('t:' + id, t);
    return { ok: true, id, pw, tid: t.tid, name, fresh: true };
  }
  track(id, since, until = 9e15) {
    if (!this.T.has(id)) return null;
    const rows = this.q('SELECT tst, lat, lon FROM trk WHERE id = ? AND tst >= ? AND tst < ? ORDER BY tst LIMIT 6000', id, since, until);
    return rows.map(r => [r.lat, r.lon, r.tst]);
  }
  trackAll(since, until) {   // 管理員：某段時間所有裝置的軌跡
    const out = {};
    for (const id of this.T.keys()) { const R = this.q('SELECT tst, lat, lon FROM trk WHERE id = ? AND tst >= ? AND tst < ? ORDER BY tst LIMIT 20000', id, since, until); if (R.length) out[id] = R.map(r => [r.lat, r.lon, r.tst]); }
    return out;
  }
  teamsGet() { return this.TM && Date.now() - this.TM.at < 600e3 ? this.TM.v : null; }   // 排班組別快取（只放記憶體，不寫儲存）
  teamsSet(v) { this.TM = { v, at: Date.now() }; }
  used(id) { const t = this.T.get(id); return this.L.has(id) || this.P.has(id) || !!(t && t.mode != null); }   // 這台有沒有連線過（＝已經裝好 OwnTracks）
  // 叫出設定 QR＝要開始用這支手機 → 自動設成值勤（匯入後直接是 Move，不會被切回省電）
  async onDuty(id) { const t = this.T.get(id); if (t && t.duty === false) { t.duty = true; t.cmdAt = 0; await this.kput('t:' + id, t); } }
  // 綁定給這個人的裝置（車子、組長自己的…）
  bound(uid) { return [...this.T.entries()].filter(([, t]) => t.uid === uid).map(([id, t]) => ({ id, name: t.name, kind: t.kind, self: !!t.self, used: this.L.has(id) || this.P.has(id) })); }
  async boundCfg(uid, id) {
    const t = this.T.get(id); if (!t || t.uid !== uid) return { error: '這台不是綁定給你的' };
    if (!t.pw) { t.pw = randStr(24); t.h = await sha256hex(t.pw); await this.kput('t:' + id, t); }
    await this.onDuty(id);
    return { ok: true, id, pw: t.pw, tid: t.tid, name: t.name, kind: t.kind, used: this.used(id) };
  }
  // 地圖更新一次只呼叫一次 DO（list＋綁定裝置＋有沒有自己的裝置）
  view(uid, mgr, who) { const items = this.list(uid, mgr, who); return items ? { items, bd: this.bound(uid), self: this.hasSelf(uid), rally: this.rallyOut(), canRally: !!mgr || this.isCmd(uid) } : null; }
  // ---- 分享位置快照（給 LINE 分享卡片用；只存分享當下的位置，6 小時後失效）----
  async shareMake(a) {
    let lat, lon, title, text, sub;
    if (a.rally) { const g = await this.rallyLoad(); if (!g || Date.now() > g.until) return { error: '目前沒有集結' };
      lat = g.lat; lon = g.lon; title = '🚩 集結通知'; text = g.msg; var due = g.due || 0, rr = g.r; sub = `範圍 ${g.r} 公尺${g.follow ? '・跟著指揮車' : ''}・有效到 ${new Date(g.until + 8 * 3600e3).toISOString().slice(11, 16)}`; }
    else { const t = this.T.get(a.id), l = this.L.get(a.id); if (!t || !l) return { error: '這台目前沒有位置' };
      lat = l.lat; lon = l.lon; title = '📍 ' + t.name + ' 的位置'; text = (a.team ? a.team + ' ' : '') + t.name + (t.kind !== '其他' && t.kind !== t.name ? '（' + t.kind + '）' : ''); sub = '位置時間 ' + new Date(l.tst + 8 * 3600e3).toISOString().slice(11, 16); }
    const k = randStr(12), img = a.rally && /^[A-Za-z0-9+/=]{1000,1400000}$/.test(a.img || '') ? 1 : 0;
    const snap = { lat, lon, title, text: cleanTxt(text, 60), sub, by: cleanTxt(a.byName, 20), at: Date.now(), until: Date.now() + 6 * 3600e3, rally: !!a.rally, due: a.rally ? due : 0, r: a.rally ? rr : 0, img };
    await this.ctx.storage.put('s:' + k, snap);
    if (img) await this.ctx.storage.put('si:' + k, a.img);   // 地圖截圖（JPEG base64），跟分享一起 6 小時後失效
    return { ok: true, k };
  }
  async shareGet(k) { const v = await this.ctx.storage.get('s:' + k); if (!v) return null; if (Date.now() > v.until) { await this.ctx.storage.delete(['s:' + k, 'si:' + k]); return null; } return v; }
  async shareImg(k) { const v = await this.shareGet(k); return v && v.img ? await this.ctx.storage.get('si:' + k) : null; }
  // ---- 集結 ----
  isCmd(uid) { return !!uid && [...this.T.values()].some(t => t.uid === uid && t.kind === '指揮車'); }   // 綁定指揮車的人可以發集結
  async rallyLoad() { if (this.G === undefined) this.G = (await this.ctx.storage.get('g:cur')) || null; return this.G; }
  rallyOut() { const g = this.G; if (!g || Date.now() > g.until) return null; return { ...g }; }
  async rallySet(a) {
    await this.rallyLoad();
    if (a.end) { if (this.G) { this.G.until = Date.now(); this.G.ended = true; await this.ctx.storage.put('g:cur', this.G); } const g = this.G; this.G = null; return { ok: true, g }; }
    let lat = +a.lat, lon = +a.lon;
    if (a.follow) { const l = this.L.get(a.follow); if (!l) return { error: '指揮車目前沒有位置，請改用「我的位置」或在地圖上點' }; lat = l.lat; lon = l.lon; }
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (!lat && !lon)) return { error: '請選集結地點' };
    const tg = (Array.isArray(a.tg) ? a.tg : []).filter(id => this.T.has(id));
    const g = { id: randStr(6), lat, lon, r: Math.min(500, Math.max(15, +a.r || 50)), msg: cleanTxt(a.msg, 60) || '請到集結點集合', by: a.by || '', byName: cleanTxt(a.byName, 20),
      follow: a.follow && this.T.has(a.follow) ? a.follow : '', tg, tgName: cleanTxt(a.tgName, 10), at: Date.now(), due: +a.due > 0 ? Date.now() + Math.min(600, +a.due) * 60e3 : 0, arr: {} };
    g.until = g.due ? g.due + 2 * 3600e3 : Date.now() + Math.min(12, Math.max(0.25, +a.hours || 3)) * 3600e3;   // 有「幾點前到」：時間過後再留 2 小時
    for (const id of tg) { const l = this.L.get(id); if (l && Date.now() - l.at < 10 * 60e3 && hav2(l.lat, l.lon, lat, lon) <= g.r) g.arr[id] = Date.now(); }   // 已經在範圍內的直接算到
    this.G = g; await this.ctx.storage.put('g:cur', g);
    return { ok: true, g, uids: [...new Set(tg.map(id => this.T.get(id).uid).filter(Boolean))] };
  }
  async rallyTick(id, l) {   // 每次收到位置：跟著指揮車移動集結點、判斷有沒有到
    const g = await this.rallyLoad(); if (!g || Date.now() > g.until) return;
    let ch = false, arrived = false;
    if (g.follow === id) { g.lat = l.lat; g.lon = l.lon; ch = true; }
    if (g.tg.includes(id) && !g.arr[id] && hav2(l.lat, l.lon, g.lat, g.lon) <= g.r) { g.arr[id] = Date.now(); arrived = true; }
    if (arrived || (ch && (!g.saved || Date.now() - g.saved > 60e3))) { g.saved = Date.now(); await this.ctx.storage.put('g:cur', g); }
  }
  async setSex(uid, sex) { if (!['m', 'f'].includes(sex)) return; for (const [id, t] of this.T) if (t.uid === uid && t.sex !== sex) { t.sex = sex; await this.kput('t:' + id, t); } }
  hasSelf(uid) { return [...this.T.values()].some(t => t.uid === uid && t.self); }
  canView(uid) { return !!uid && (this.V.has(uid) || [...this.T.values()].some(t => t.uid === uid)); }
  list(uid, mgr, who) {
    if (!mgr && !(who && who.sc) && !LOC_OPEN && !this.canView(uid)) return null;
    const now = Date.now();
    if (uid) {   // 記錄誰在看（記憶體每次更新，寫入儲存最多 5 分鐘一次）
      const w = this.W.get(uid) || { n: 0, first: now, day: '' }, day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
      if (w.day !== day) { w.day = day; w.first = now; w.n = 0; }
      w.n++; w.last = now; w.name = (who && who.n) || w.name || ''; this.W.set(uid, w);
      if (!w.saved || now - w.saved > 300e3) { w.saved = now; this.kput('w:' + uid, w); }
    }
    return [...this.T.entries()].map(([id, t]) => { const l = this.L.get(id); const duty = t.duty !== false; return { id, name: t.name, kind: t.kind, uname: t.uname || '', pic: t.pic || '', fig: (t.fig !== 'emt' && t.fig) || t.sex || '', rkey: t.rkey || '', duty, mode: t.mode ?? null, loc: l && (now - l.at <= LOC_TTL || !duty) ? l : null }; });
  }
  // 管理（Worker 已確認是完整管理員）
  async admin(op, a) {
    const st = this.ctx.storage;
    if (op === 'state') return { trackers: [...this.T.entries()].map(([id, t]) => ({ id, name: t.name, kind: t.kind, tid: t.tid, uid: t.uid || '', uname: t.uname || '', fig: t.fig || '', sex: t.sex || '', pic: t.pic || '', self: !!t.self, at: t.at, last: (this.L.get(id) || {}).at || 0, duty: t.duty !== false, mode: t.mode ?? null, ping: this.P.get(id) || 0 })),
                                 rejects: [...(this.R || new Map()).entries()].filter(([, r]) => Date.now() - r.at < 86400e3).map(([id, r]) => ({ id, ...r })),
                                 viewers: [...this.V.entries()].map(([uid, v]) => ({ uid, name: v.name || '' })),
                                 watchers: [...this.W.entries()].filter(([, w]) => Date.now() - w.last < 3 * 86400e3).sort((a, b) => b[1].last - a[1].last)
                                   .map(([uid, w]) => ({ uid, name: w.name || '', last: w.last, first: w.first, day: w.day, n: w.n })) };
    if (op === 'add' || op === 'edit') {
      const name = cleanTxt(a.name, 20); if (!name) return { error: '請填名稱' };
      const kind = LOC_KINDS.includes(a.kind) ? a.kind : '其他';
      const uid = /^U[0-9a-f]{32}$/.test(a.uid || '') ? a.uid : '';
      if (op === 'edit') { const t = this.T.get(a.id); if (!t) return { error: '找不到裝置' };
        if (['m', 'f', ''].includes(a.fig)) t.fig = a.fig;
        if (['m', 'f', ''].includes(a.sex)) t.sex = a.sex;
        Object.assign(t, { name, kind, uid, uname: uid ? cleanTxt(a.uname, 20) : '', pic: uid ? picOk(a.pic) : '', rkey: uid ? cleanTxt(a.rkey, 20) : '', tid: locTid(kind, a.id) });
        await this.kput('t:' + a.id, t); return { ok: true }; }
      let id; do { id = 'bst' + randStr(5, 'abcdefghijkmnpqrstuvwxyz23456789'); } while (this.T.has(id));
      const pw = randStr(24);
      const t = { sex: ['m', 'f'].includes(a.sex) ? a.sex : '', name, kind, uid, uname: uid ? cleanTxt(a.uname, 20) : '', pic: uid ? picOk(a.pic) : '', rkey: uid ? cleanTxt(a.rkey, 20) : '', tid: locTid(kind, id), h: await sha256hex(pw), pw, at: Date.now(), by: a.by || '' };
      this.T.set(id, t); await this.kput('t:' + id, t);
      return { ok: true, id, pw, tid: t.tid, name };
    }
    if (op === 'reset') { const t = this.T.get(a.id); if (!t) return { error: '找不到裝置' };
      const pw = randStr(24); t.h = await sha256hex(pw); t.pw = pw; await this.kput('t:' + a.id, t); await this.onDuty(a.id); return { ok: true, id: a.id, pw, tid: t.tid, name: t.name }; }
    if (op === 'qr') { const t = this.T.get(a.id); if (!t) return { error: '找不到裝置' }; if (!t.pw) return this.admin('reset', a); await this.onDuty(a.id); return { ok: true, id: a.id, pw: t.pw, tid: t.tid, name: t.name, used: this.used(a.id) }; }
    if (op === 'del') { this.T.delete(a.id); this.L.delete(a.id); await this.kdel(['t:' + a.id, 'l:' + a.id]); this.q('DELETE FROM trk WHERE id = ?', a.id); return { ok: true }; }
    if (op === 'duty') {   // { id 或 all:true, on }：退勤時位置立刻從地圖清掉
      const ids = a.all ? [...this.T.keys()] : [a.id]; let n = 0;
      for (const id of ids) { const t = this.T.get(id); if (!t) continue; t.duty = !!a.on; t.cmdAt = 0; await this.kput('t:' + id, t); n++;
}
      return n ? { ok: true, n } : { error: '找不到裝置' };
    }
    if (op === 'clear') { this.L.delete(a.id); await this.kdel('l:' + a.id); return { ok: true }; }
    if (op === 'viewer') { if (!/^U[0-9a-f]{32}$/.test(a.uid || '')) return { error: 'bad uid' };
      if (a.on) { const v = { name: cleanTxt(a.name, 20), at: Date.now() }; this.V.set(a.uid, v); await this.kput('v:' + a.uid, v); }
      else { this.V.delete(a.uid); await this.kdel('v:' + a.uid); }
      return { ok: true }; }
    return { error: 'bad op' };
  }
}

async function otRoute(req, env) {
  const deny = () => new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="bst"' } });
  if (!env.LOC) return new Response('not configured', { status: 501 });
  const h = req.headers.get('Authorization') || ''; let user = '', pass = '';
  if (/^Basic /i.test(h)) { try { const s = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6).trim()), c => c.charCodeAt(0))); const i = s.indexOf(':'); if (i > 0) { user = s.slice(0, i); pass = s.slice(i + 1); } } catch (e) {} }
  if (!/^bst[a-z0-9]{5}$/.test(user)) return deny();
  let m = null; try { m = await req.json(); } catch (e) {}
  const r = await locHub(env).pub(user, pass, m);
  if (!r.auth) return deny();
  return new Response(JSON.stringify(r.out || []), { headers: { 'Content-Type': 'application/json' } });
}
let LOC_KEY = null;
const locKey = env => LOC_KEY || (LOC_KEY = crypto.subtle.importKey('raw', new TextEncoder().encode('bst-loc|' + env.SERVICE_ACCOUNT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
async function locSign(body, env) { return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await locKey(env), new TextEncoder().encode(body)))); }
async function locSessMake(s, env) { const body = b64url(new TextEncoder().encode(JSON.stringify(s))); return body + '.' + await locSign(body, env); }
async function locSessRead(tok, env) {
  try { const [body, sig] = String(tok || '').split('.'); if (!body || !sig || sig !== await locSign(body, env)) return null;
    const s = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    return s.exp > Date.now() && s.v === 2 ? s : null; } catch (e) { return null; }   // v2：多了今天有沒有排班
}
async function locSession(idToken, sess, env) {
  let s = await locSessRead(sess, env), fresh = null;
  if (!s) {
    if (!idToken) return { err: 'login' };
    const uid = uidOfToken(idToken), me = await fsUser(idToken, uid);
    if (!me || me.status !== 'approved') return { err: '帳號尚未開通' };
    const R = await locRole(idToken, env), ld = R.ld, sc = R.sc; if (R.me && R.me.sex && env.LOC) try { await locHub(env).setSex(uid, R.me.sex); } catch (e) {}
    s = { uid, n: String(me.realName || '').slice(0, 20), m: await fullAdmin(me, idToken, env), ld, sc, v: 2, exp: Date.now() + LOC_SESS };
    fresh = await locSessMake(s, env);
  }
  return { s, fresh };
}
// 軌跡：{ sess|idToken, id, since }（預設今天 0 點起，最多 3 天）
async function locTrackRoute(req, env, json) {
  try {
    if (!env.LOC) return json({ error: '定位功能尚未部署' }, 501);
    const { idToken, sess, id, since, all, day } = await req.json();
    const A = await locSession(idToken, sess, env); if (A.err) return json({ error: A.err }, 401);
    const hub = locHub(env);
    if (all) {   // 管理員後台：某一天所有人的軌跡（30 天內）
      if (!A.s.m) return json({ error: '只有管理員可以看所有人的軌跡' }, 403);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return json({ error: 'bad day' }, 400);
      const d0 = Date.parse(day + 'T00:00:00+08:00'); if (!(d0 > Date.now() - TRK_KEEP - 86400e3)) return json({ error: '只保留 30 天' }, 400);
      return json({ ok: true, tracks: await hub.trackAll(d0, d0 + 86400e3), sess: A.fresh });
    }
    if (!A.s.m && !A.s.sc && !LOC_OPEN && !(await hub.canView(A.s.uid))) return json({ error: '沒有權限' }, 403);
    const today = Date.parse(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00+08:00');
    const t0 = Math.max(Number(since) || today, Date.now() - 3 * 86400e3);
    const pts = await hub.track(String(id || ''), t0);
    if (!pts) return json({ error: '找不到裝置' }, 404);
    return json({ ok: true, pts, sess: A.fresh });
  } catch (e) { return json({ error: e.code ? '請重新登入' : String((e && e.message) || e) }, e.code || 500); }
}
// 集結通知：完整管理員、綁定指揮車的人可以發（不推播，用「分享」卡片傳到群組）
async function locShareRoute(req, env, json) {
  try {
    if (!env.LOC) return json({ error: '定位功能尚未部署' }, 501);
    const a = await req.json(), A = await locSession(a.idToken, a.sess, env); if (A.err) return json({ error: A.err }, 401);
    const hub = locHub(env);
    if (!A.s.m && !A.s.sc && !(await hub.canView(A.s.uid))) return json({ error: '沒有權限' }, 403);
    const r = await hub.shareMake({ rally: !!a.rally, id: String(a.id || ''), team: cleanTxt(a.team, 10), byName: A.s.n, img: typeof a.img === 'string' ? a.img : '' });
    return json(r.error ? r : { ok: true, url: 'https://liff.line.me/2011820105-Is9eno4N?share=ls_' + r.k, sess: A.fresh }, r.error ? 400 : 200);
  } catch (e) { return json({ error: e.code ? '請重新登入' : String((e && e.message) || e) }, e.code || 500); }
}
async function locRallyRoute(req, env, json) {
  try {
    if (!env.LOC) return json({ error: '定位功能尚未部署' }, 501);
    const a = await req.json(), A = await locSession(a.idToken, a.sess, env); if (A.err) return json({ error: A.err }, 401);
    const hub = locHub(env); await hub.rallyLoad();
    if (!A.s.m && !(await hub.isCmd(A.s.uid))) return json({ error: '只有管理員或指揮車可以發集結通知' }, 403);
    if (a.end) { await hub.rallySet({ end: true }); return json({ ok: true, sess: A.fresh }); }
    const r = await hub.rallySet({ ...a, by: A.s.uid, byName: A.s.n });
    if (r.error) return json(r, 400);
    return json({ ok: true, rally: r.g, sess: A.fresh });
  } catch (e) { return json({ error: e.code ? '請重新登入' : String((e && e.message) || e) }, e.code || 500); }
}
async function locRoute(req, env, json) {
  try {
    if (!env.LOC) return json({ error: '定位功能尚未部署' }, 501);
    const { idToken, sess } = await req.json();
    let s = await locSessRead(sess, env), fresh = null;
    if (!s) {
      if (!idToken) return json({ error: 'login' }, 401);
      const uid = uidOfToken(idToken), me = await fsUser(idToken, uid);
      if (!me || me.status !== 'approved') return json({ error: '帳號尚未開通' }, 403);
      const R = await locRole(idToken, env), ld = R.ld, sc = R.sc; if (R.me && R.me.sex && env.LOC) try { await locHub(env).setSex(uid, R.me.sex); } catch (e) {}
      s = { uid, n: String(me.realName || '').slice(0, 20), m: await fullAdmin(me, idToken, env), ld, sc, v: 2, exp: Date.now() + LOC_SESS };
      fresh = await locSessMake(s, env);
    }
    const hub = locHub(env); await hub.rallyLoad();
    const V = await hub.view(s.uid, s.m, { n: s.n, sc: s.sc }), items = V && V.items;
    if (!items) return json({ error: '今天有排班的人才能看定位地圖。需要的話請找管理員加入「可以看地圖的人」', canSelf: true }, 403);
    try { const T = await locTeams(env); items.forEach(i => { i.team = i.rkey ? (T.today[i.rkey] || '') : ''; delete i.rkey; }); } catch (e) { items.forEach(i => delete i.rkey); }
    const bd = V.bd;
    const selfNeed = (!!s.ld && !V.self) || bd.some(b => !b.used);   // 組長還沒產生、或綁定的裝置還沒連線過 → 自動跳設定
    return json({ ok: true, items, mgr: s.m, canSelf: !!(s.ld || s.m || bd.length), selfNeed, rally: V.rally, canRally: V.canRally, sess: fresh, exp: s.exp, now: Date.now() });
  } catch (e) { return json({ error: e.code ? '請重新登入' : String((e && e.message) || e) }, e.code || 500); }
}
// 團員專區用：要不要顯示「定位」按鈕（只回 true/false，不含任何位置）
async function locCanRoute(req, env, json) {
  try { const { idToken } = await req.json(); if (!idToken || !env.LOC) return json({ can: false });
    if (LOC_OPEN || await locHub(env).canView(uidOfToken(idToken))) return json({ can: true });
    const R = await locRole(idToken, env); return json({ can: R.sc || R.ld }); } catch (e) { return json({ can: false }); }
}
// 小組長自己產生 OwnTracks 設定（今天排班是小組長的人；完整管理員也可以；綁定裝置的人拿綁定那台）
async function locSelfRoute(req, env, json) {
  try {
    if (!env.LOC) return json({ error: '定位功能尚未部署' }, 501);
    const body = await req.json(), { idToken } = body; if (!idToken) return json({ error: 'login' }, 401);
    const me = await locMe(idToken, env); if (!me) return json({ error: '帳號尚未開通' }, 403);
    const T = await locTeams(env), lead = me.rkey in (T.leadNow || {}), hub = locHub(env), team = T.today[me.rkey] || T.leads[me.rkey] || '';
    const { id } = body;
    if (id) { const r = await hub.boundCfg(me.uid, String(id)); return json(r.error ? r : { ...r, team: r.kind === '小組長' ? team : '' }, r.error ? 403 : 200); }
    const canMake = lead || await fullAdmin(await fsUser(idToken, me.uid), idToken, env);
    if (canMake) await hub.selfGet(me.uid, { name: me.name, pic: me.pic, rkey: me.rkey, sex: me.sex });   // 組長／管理員：確保有自己的一台
    const mine = await hub.bound(me.uid);
    if (!mine.length) return json({ error: '今天排班是小組長才能產生 QR Code，其他人請找管理員綁定裝置' }, 403);
    if (mine.length > 1) return json({ ok: true, choose: mine, team });
    const r = await hub.boundCfg(me.uid, mine[0].id);
    return json({ ...r, team: r.kind === '小組長' ? team : '' });
  } catch (e) { return json({ error: e.code ? '請重新登入' : String((e && e.message) || e) }, e.code || 500); }
}
async function locAdminRoute(req, env, json) {
  try {
    if (!env.LOC) return json({ error: '定位功能尚未部署' }, 501);
    const a = await req.json();
    if (!a.idToken) return json({ error: 'missing' }, 400);
    const uid = uidOfToken(a.idToken), me = await fsUser(a.idToken, uid);
    if (!(await fullAdmin(me, a.idToken, env))) return json({ error: '只有完整管理員或開發者可以管理定位裝置' }, 403);
    const hub = locHub(env);
    if (a.op === 'members') {   // 選人用：只回 ID 和姓名，不含其他個資
      const tok = await saToken(env), dev = await devUid(tok);
      const ros = {}, sx = {}; (await memo('roster', 300e3, () => fsList(tok, 'member_roster'))).forEach(r => { ros[r.id] = normName(r.name); sx[r.id] = sexOf(r.idCard); });
      const members = (await fsList(tok, 'users')).filter(u => u.status === 'approved' && /^U[0-9a-f]{32}$/.test(u.id) && (u.id !== dev || uid === dev))
        .map(u => ({ uid: u.id, name: String(u.realName || u.displayName || '').slice(0, 20), pic: picOk(u.pictureUrl), sex: sx[u.rosterId] || '', rkey: ros[u.rosterId] || normName(u.realName) }))
        .filter(u => u.name).sort((x, y) => x.name.localeCompare(y.name, 'zh-Hant'));
      return json({ ok: true, members });
    }
    const r = await hub.admin(String(a.op || ''), { ...a, idToken: undefined, by: uid });
    return json(r, r.error ? 400 : 200);
  } catch (e) { return json({ error: e.code ? '請重新登入' : String((e && e.message) || e) }, e.code || 500); }
}
