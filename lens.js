// 長按放大鏡（全站共用）：手指按住畫面不放約半秒 → 跳出圓形放大鏡，移動手指看別處，放開就消失
// 頁面可設定 window.__lensOk = () => true/false 決定目前能不能用；元素加 data-nolens 就不觸發
(() => {
  if (window.__lensInit) return; window.__lensInit = true;
  const Z = 2.4, HOLD = 420;
  let R = 140, timer = null, on = false, sx = 0, sy = 0, lens = null, inner = null, blockClick = 0;
  const st = document.createElement('style');
  st.textContent = `#g-lens{display:none;position:fixed;z-index:2147483600;border-radius:50%;overflow:hidden;pointer-events:none;border:4px solid #fff;
    box-shadow:0 0 0 2px rgba(214,90,104,.85),0 14px 34px rgba(0,0,0,.45);background:#fff}
    #g-lens .gl-in{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden}
    #g-lens *{animation:none!important;transition:none!important;caret-color:transparent}
    html.gl-hold,html.gl-hold *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}`;
  document.head.appendChild(st);
  const clearSel = () => { try { const g = getSelection(); g && g.rangeCount && g.removeAllRanges(); } catch (e) {} };
  const allowed = t => {
    if (typeof window.__lensOk === 'function' && !window.__lensOk(t)) return false;
    if (t && t.closest && t.closest('[data-nolens],input:not([readonly]):not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit]),textarea:not([readonly]),select,[contenteditable="true"],canvas')) return false;
    return true;
  };
  function build() {
    const W = innerWidth, H = innerHeight, bs = getComputedStyle(document.body);
    if (!lens) { lens = document.createElement('div'); lens.id = 'g-lens'; document.body.appendChild(lens); }
    R = Math.min(140, Math.round((W - 24) / 2 * 0.78));
    lens.style.width = lens.style.height = R * 2 + 'px';
    lens.innerHTML = '';
    inner = document.createElement('div'); inner.className = 'gl-in';
    Object.assign(inner.style, { width: W + 'px', height: H + 'px', background: bs.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : bs.backgroundColor,
      color: bs.color, font: bs.font, fontFamily: bs.fontFamily, lineHeight: bs.lineHeight });
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { position: 'absolute', left: -scrollX + 'px', top: -scrollY + 'px', width: document.documentElement.scrollWidth + 'px' });
    wrap.className = document.body.className;
    const src = [...document.body.children].filter(e => e !== lens && !/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(e.tagName));
    const pairs = [];
    src.forEach(e => {
      const c = e.cloneNode(true); wrap.appendChild(c);
      const a = [e, ...e.querySelectorAll('*')], b = [c, ...c.querySelectorAll('*')];
      for (let i = 0; i < a.length && i < b.length; i++) pairs.push([a[i], b[i]]);
    });
    pairs.forEach(([o, c]) => {
      if (c.tagName === 'INPUT' && (c.type === 'radio' || c.type === 'checkbox')) { c.name = (c.name || '') + '__lens'; c.checked = o.checked; }
      else if (c.tagName === 'INPUT' || c.tagName === 'TEXTAREA') c.value = o.value;
      else if (c.tagName === 'SELECT') c.selectedIndex = o.selectedIndex;
      else if (c.tagName === 'IFRAME' || c.tagName === 'VIDEO') { const d = document.createElement('div'); d.style.cssText = c.style.cssText + ';background:#e5e7eb'; d.className = c.className; c.replaceWith(d); }
      else if (c.tagName === 'CANVAS') { try { c.getContext('2d').drawImage(o, 0, 0); } catch (e) {} }
    });
    inner.appendChild(wrap); lens.appendChild(inner);
    // 有捲動的區塊，複製後要捲到一樣的位置
    pairs.forEach(([o, c]) => { if (o.scrollTop || o.scrollLeft) { c.scrollTop = o.scrollTop; c.scrollLeft = o.scrollLeft; } });
  }
  function move(x, y) {
    if (!on) return;
    inner.style.transform = `translate(${R - Z * x}px,${R - Z * y}px) scale(${Z})`;
    let lx = x - R, ly = y - R * 2 - 30; if (ly < 8) ly = y + 40;
    lx = Math.max(6, Math.min(innerWidth - R * 2 - 6, lx));
    lens.style.left = lx + 'px'; lens.style.top = ly + 'px';
  }
  function show(x, y) { try { build(); } catch (e) { console.warn('lens', e); return; } lens.style.display = 'block'; on = true; clearSel(); try { navigator.vibrate && navigator.vibrate(15); } catch (e) {} move(x, y); }
  function hide() { clearTimeout(timer); timer = null; document.documentElement.classList.remove('gl-hold'); if (on) { blockClick = Date.now(); on = false; if (lens) { lens.style.display = 'none'; lens.innerHTML = ''; } } }
  addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || !allowed(e.target)) return hide();
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; document.documentElement.classList.add('gl-hold');
    clearTimeout(timer); timer = setTimeout(() => { timer = null; show(sx, sy); }, HOLD);
  }, { passive: true, capture: true });
  addEventListener('touchmove', e => {
    const t = e.touches[0]; if (!t) return;
    if (on) { e.preventDefault(); e.stopImmediatePropagation(); move(t.clientX, t.clientY); return; }
    if (timer && Math.hypot(t.clientX - sx, t.clientY - sy) > 10) { clearTimeout(timer); timer = null; document.documentElement.classList.remove('gl-hold'); }
  }, { passive: false, capture: true });
  addEventListener('touchend', e => { if (on) { e.preventDefault(); e.stopImmediatePropagation(); } hide(); }, { passive: false, capture: true });
  addEventListener('touchcancel', hide, { capture: true });
  addEventListener('scroll', () => { if (timer) { clearTimeout(timer); timer = null; document.documentElement.classList.remove('gl-hold'); } }, { capture: true, passive: true });
  ['pointermove', 'pointerup'].forEach(t => addEventListener(t, e => { if (on) e.stopImmediatePropagation(); }, { capture: true }));
  addEventListener('click', e => { if (Date.now() - blockClick < 500) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true });
  document.addEventListener('selectionchange', () => { if (on || timer) clearSel(); });
  addEventListener('selectstart', e => { if (on || timer) e.preventDefault(); }, { capture: true });
  addEventListener('contextmenu', e => { if (on || timer) e.preventDefault(); }, { capture: true });
  const css = document.createElement('style'); css.textContent = 'body{-webkit-touch-callout:none}'; document.head.appendChild(css);
})();
