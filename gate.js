// 團員功能開關（倉庫管理、救護紀錄表共用）
// 團員功能關閉時，一般團員登入後整個畫面被公告蓋住；管理員、單獨開放的團員不受影響。
// 用法：bstGate.apply(使用者資料)；資料有變動時再呼叫一次即可。
(function () {
  const URL = 'https://bst-auth.eurekateamstar.workers.dev/gate';
  const KEY = 'bst_gate';
  let open = (() => { try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; } })();
  let last = null, fetched = false;

  const isRegular = u => !!u && !(u.role === 'admin' || u.adminMember === true || u.adminWarehouse === true || u.adminRecord === true);
  const gated = u => !open && !!u && u.status === 'approved' && isRegular(u) && u.earlyAccess !== true;

  function css() {
    if (document.getElementById('bst-gate-css')) return;
    const s = document.createElement('style'); s.id = 'bst-gate-css';
    s.textContent = `
#bst-gate{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:22px;
  background:linear-gradient(160deg,#fff7ed 0%,#fef2f2 55%,#fff 100%);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif;overflow:auto}
#bst-gate .bg-card{width:100%;max-width:420px;background:#fff;border-radius:22px;box-shadow:0 10px 40px rgba(220,38,38,.14);padding:26px 20px 22px;text-align:center;border:1.5px solid #fed7aa}
#bst-gate .bg-car{display:block;width:72%;max-width:260px;height:auto;margin:-4px auto 10px}
#bst-gate h2{margin:0 0 4px;font-size:21px;color:#b91c1c;font-weight:900;letter-spacing:.5px}
#bst-gate .bg-tag{display:inline-block;margin:6px 0 16px;padding:4px 14px;border-radius:99px;background:#fee2e2;color:#b91c1c;font-size:13px;font-weight:800}
#bst-gate .bg-body{font-size:15px;line-height:1.75;color:#374151;text-align:left}
#bst-gate .bg-body p{margin:0 0 12px}
#bst-gate .bg-date{background:#fff7ed;border:1.5px dashed #fdba74;border-radius:14px;padding:12px 14px;margin:4px 0 14px;font-weight:800;color:#9a3412;text-align:center;line-height:1.7}
#bst-gate .bg-btn{display:block;width:100%;margin-top:6px;padding:13px;border:0;border-radius:14px;background:#06c755;color:#fff;font-size:16px;font-weight:800;cursor:pointer}
#bst-gate .bg-foot{margin-top:12px;font-size:12px;color:#9ca3af}
body.bst-gated{overflow:hidden!important}`;
    document.head.appendChild(s);
  }

  function show() {
    css();
    document.body.classList.add('bst-gated');
    if (document.getElementById('bst-gate')) return;
    const d = document.createElement('div'); d.id = 'bst-gate';
    d.innerHTML = `<div class="bg-card">
  <img class="bg-car" src="/member/car-mazu.png" alt="媽祖車">
  <h2>醫護團小通知</h2>
  <div class="bg-tag">🔒 尚未開放</div>
  <div class="bg-body">
    <p>嗨嗨各位夥伴～<br>團員功能目前進入「準備模式」😴</p>
    <p>團員專區、倉庫管理、救護紀錄點進去會看到「尚未開放」<br>別擔心，不是系統壞掉，是我們在幫它升級打扮中✨</p>
  </div>
  <div class="bg-date">📅 等到進香前就會正式開放！<br>開放那天會第一時間通知大家🔔</div>
  <div class="bg-body"><p>這段時間有任何問題，一樣找幹部就對了👍<br>進香前見囉～💪</p></div>
  <button class="bg-btn" id="bst-gate-back">回到 LINE</button>
  <div class="bg-foot">衛教資訊、全民醫護證、醫護足跡在 LINE 選單裡都可以照常使用</div>
</div>`;
    document.body.appendChild(d);
    document.getElementById('bst-gate-back').onclick = () => {
      try { if (window.liff && liff.isInClient && liff.isInClient()) { liff.closeWindow(); return; } } catch (e) {}
      location.href = 'https://line.me/R/ti/p/@393geitc';
    };
    try { window.bstUsage && bstUsage.track && bstUsage.track('gate_block'); } catch (e) {}
  }

  function hide() {
    const d = document.getElementById('bst-gate'); if (d) d.remove();
    document.body && document.body.classList.remove('bst-gated');
  }

  function paint() { if (gated(last)) show(); else hide(); }

  function refresh() {
    return fetch(URL, { cache: 'no-store' }).then(r => r.json()).then(j => {
      open = j.open !== false; fetched = true;
      try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (e) {}
      paint();
    }).catch(() => {});
  }

  window.bstGate = {
    apply(u) { last = u || null; paint(); if (!fetched && last && isRegular(last)) refresh(); },
    refresh,
    isGated: () => gated(last)
  };
  // 回到前景時重新確認（管理員可能剛開放）
  document.addEventListener('visibilitychange', () => { if (!document.hidden && last && isRegular(last)) refresh(); });
})();
