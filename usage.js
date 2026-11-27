// 使用分析：記下「哪一頁打開幾次、用了哪些功能」，離開頁面時一次送出（不會每點一下就送）
// 用法：<script src="/usage.js" data-page="member"></script>
//   bstUsage.track('my_day')         記一次功能
//   bstUsage.token(() => auth.currentUser && auth.currentUser.getIdToken())   登入後提供身分（不提供＝匿名）
(() => {
  if (window.bstUsage) return;
  const W = 'https://bst-auth.eurekateamstar.workers.dev/usage';
  const PAGE = (document.currentScript && document.currentScript.dataset.page) || '';
  const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  let buf = { v: 0, q: 0, f: {} }, tok = '', getTok = null, hiddenAt = 0; const timed = {};
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  const view = () => { buf.v++; const k = 'bstU_' + PAGE; if (ls(k) !== day()) { ls(k, day()); buf.q = 1; } };
  const refresh = () => { if (!getTok) return; try { Promise.resolve(getTok()).then(t => { if (t) tok = t; }, () => {}); } catch (e) {} };
  const flush = () => {
    if (!PAGE || (!buf.v && !Object.keys(buf.f).length)) return;
    const body = JSON.stringify({ p: PAGE, v: buf.v, q: buf.q, f: buf.f, t: tok || undefined });
    buf = { v: 0, q: 0, f: {} };
    try { fetch(W, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {}); } catch (e) {}
  };
  window.bstUsage = {
    track(f) { if (!/^[a-z][a-z0-9_]{0,39}$/.test(f)) return; buf.f[f] = Math.min(50, (buf.f[f] || 0) + 1); refresh(); },
    // 記數量（目前用在：瀏覽器讀了幾筆資料庫，rd_集合名）
    add(f, n) { if (!/^[a-z][a-z0-9_]{0,39}$/.test(f) || !(n > 0)) return; buf.f[f] = Math.min(50000, (buf.f[f] || 0) + n); refresh(); },
    // 包住 Firestore 的讀取函式，算這個頁面讀了幾筆、讀哪個集合（從快取拿的不算，跟 Firebase 計費一樣）
    fsWrap(F) {
      const key = r => { try { const p = r.path || (r._query && r._query.path && r._query.path.canonicalString()) || (r._path && r._path.canonicalString()) || '';
        const seg = String(p).split('/').filter(Boolean), c = seg.filter((_, i) => i % 2 === 0).join('_');
        return 'rd_' + PAGE.slice(0, 2) + '_' + (c.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 33) || 'other'); } catch (e) { return 'rd_' + PAGE.slice(0, 2) + '_other'; } };
      const cnt = (r, n) => { if (n > 0) window.bstUsage.add(key(r), n); };
      const isQ = s => s && typeof s.size === 'number';
      const out = {};
      if (F.getDoc) out.getDoc = (r, ...a) => F.getDoc(r, ...a).then(s => { if (!(s.metadata && s.metadata.fromCache)) cnt(r, 1); return s; });
      for (const k of ['getDocs', 'getDocsFromServer']) if (F[k]) out[k] = (r, ...a) => F[k](r, ...a).then(s => { if (!(s.metadata && s.metadata.fromCache)) cnt(r, Math.max(1, s.size)); return s; });
      if (F.onSnapshot) out.onSnapshot = (r, ...a) => { let first = true;
        const i = a.findIndex(x => typeof x === 'function' || (x && typeof x.next === 'function'));
        if (i < 0) return F.onSnapshot(r, ...a);
        const orig = a[i], nx = typeof orig === 'function' ? orig : orig.next.bind(orig);
        const w = s => { try { if (!(s.metadata && s.metadata.fromCache)) { cnt(r, isQ(s) ? (first ? Math.max(1, s.size) : s.docChanges().length) : 1); first = false; } } catch (e) {} return nx(s); };
        a[i] = typeof orig === 'function' ? w : { ...orig, next: w }; return F.onSnapshot(r, ...a); };
      return out;
    },
    token(fn) { getTok = fn; refresh(); },
    flush,
    // 記載入時間（毫秒）：分成 <1、1-2、2-3、3-5、5-8、8-12、>12 秒，同一個項目一頁只記一次
    time(m, ms) { if (!/^[a-z][a-z0-9]{0,15}$/.test(m) || timed[m]) return; timed[m] = 1; const s = ms / 1000;
      const b = s < 1 ? 'b1' : s < 2 ? 'b2' : s < 3 ? 'b3' : s < 5 ? 'b5' : s < 8 ? 'b8' : s < 12 ? 'b12' : 'bx'; window.bstUsage.track('t_' + m + '_' + b); },
    // 包住網頁上的全域函式：{ 函式名: '功能名' 或 (參數…) => '功能名' }；函式晚一點才出現也會補包
    wrap(map) { const go = () => Object.entries(map).forEach(([fn, f]) => { const o = window[fn]; if (typeof o !== 'function' || o.__bstW) return;
        const w = function (...a) { try { const n = typeof f === 'function' ? f(...a) : f; if (n) window.bstUsage.track(n); } catch (e) {} return o.apply(this, a); };
        w.__bstW = 1; window[fn] = w; });
      go(); addEventListener('load', go); [1500, 4000, 10000].forEach(t => setTimeout(go, t)); },
    // 點到符合的元素就記一次：{ 'CSS選擇器': '功能名' 或 el => '功能名' }
    clicks(map) { document.addEventListener('click', e => { const t = e.target; if (!t || !t.closest) return;
        for (const [sel, f] of Object.entries(map)) { const el = t.closest(sel); if (el) { try { const n = typeof f === 'function' ? f(el) : f; if (n) window.bstUsage.track(n); } catch (x) {} } } }, true); },
  };
  view();
  // 從哪裡進來：網址上的 src（LINE 選單回覆＝menu、分享卡片＝share、通知＝n_xxx），沒有就是 direct（直接開、掃 QR、書籤）
  try { const q = new URLSearchParams(location.search); let src = q.get('src') || '';
    if (!src && q.get('liff.state')) src = new URLSearchParams(q.get('liff.state').replace(/^[^?]*\?/, '')).get('src') || '';
    src = String(src).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 14) || 'direct';
    window.bstUsage.track('src_' + PAGE + '_' + src); } catch (e) {}
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); flush(); }
    else if (hiddenAt && Date.now() - hiddenAt > 30 * 60e3) { view(); refresh(); }   // 離開超過 30 分鐘再回來＝再開一次
    else refresh();
  });
  addEventListener('pagehide', flush);
  setInterval(() => { if (Object.keys(buf.f).some(k => k.startsWith('rd_'))) flush(); }, 3 * 60e3);   // 讀取筆數每 3 分鐘先送一次（LINE 直接關掉常常送不出去）
  setInterval(refresh, 20 * 60e3);   // 權杖一小時過期，定時換新
  { let n = 0; const t = setInterval(() => { if (tok || ++n > 30) return clearInterval(t); refresh(); }, 4000); }   // 剛打開還沒登入：登入好就拿到身分
})();
