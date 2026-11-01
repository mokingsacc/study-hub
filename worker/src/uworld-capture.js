export function captureBlock(HUB, pace = 1, keep = false) {
  const W = window;
  if (!/uworld/i.test(location.hostname)) return 'This is not a UWorld page. Open the block\'s review in UWorld (item 1) and run it there.';
  const old = W.__hubCapture;
  if (old && old.state === 'running') return old.status();
  const MAX = 60, TEXT = 20000;
  const C = W.__hubCapture = { state: 'running', pages: [], note: null, total: null, last: null };
  const sleep = ms => new Promise(r => setTimeout(r, ms * pace));   // pace: tests run it faster
  const docs = () => {
    const out = [document];
    for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) out.push(f.contentDocument); } catch (e) { /* another site's frame */ } }
    return out;
  };
  const pageText = () => docs().map(d => (d.body ? d.body.innerText : '')).join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const qidOf = t => { const m = /Question\s*Id\s*:?\s*(\d{2,8})/i.exec(t); return m ? m[1] : null; };
  const itemOf = t => { const m = /Item:?\s*(\d{1,2})\s*of\s*(\d{1,2})/i.exec(t); return m ? { n: Number(m[1]), of: Number(m[2]) } : null; };
  const keyOf = t => qidOf(t) || (itemOf(t) ? `item ${itemOf(t).n}` : t.slice(0, 400));
  const shown = el => {
    const r = el.getBoundingClientRect(), s = (el.ownerDocument.defaultView || W).getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const stepButton = (word = 'next') => {
    const re = new RegExp(`^${word}( question| item)?$`, 'i');
    for (const d of docs()) for (const el of d.querySelectorAll('button, a, [role="button"], [aria-label], [title]')) {
      const said = [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim());
      if (!said.some(s => re.test(s))) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !shown(el)) continue;
      return el;
    }
    return null;
  };
  const nextButton = () => stepButton('next');
  const marks = () => {
    const out = [];
    const add = line => { if (!out.includes(line) && out.length < 12) out.push(line); };
    for (const d of docs()) {
      for (const el of d.querySelectorAll('input[type="radio"]:checked')) {
        const box = el.closest('label, li, tr, div');
        const t = box ? box.innerText.replace(/\s+/g, ' ').trim() : '';
        if (t) add(`checked: ${t.slice(0, 100)}`);
      }
      for (const el of d.querySelectorAll('[class]')) {
        const cls = String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className);
        const m = /(?:^|[\s_-])(correct|incorrect|selected|chosen|user-?answer|your-?answer|wrong)(?:$|[\s_-])/i.exec(cls);
        if (!m) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 160) add(`${m[1].toLowerCase()}: ${t.slice(0, 100)}`);
      }
    }
    return out.join(' | ');
  };
  C.grab = () => {
    const t = pageText();
    if (!t) return 'The page has no text yet.';
    const id = qidOf(t), it = itemOf(t);
    if (it && it.of) C.total = it.of;
    const key = keyOf(t);
    if (C.pages.some(p => p.key === key)) return 'Already read this one.';
    C.pages.push({ key, n: it ? it.n : C.pages.length + 1, id, text: t.slice(0, TEXT), marks: marks() });
    if (C.pages.length === 1 && it && it.n > 1) C.note = `started at item ${it.n}: open item 1 for the whole block`;
    return `Read ${it ? `item ${it.n}` : `page ${C.pages.length}`}${id ? ` (Question Id ${id})` : ''}.`;
  };
  C.status = () => `${C.state}: ${C.pages.length}${C.total ? ` of ${C.total}` : ''} questions read${C.note ? ` (${C.note})` : ''}${
    C.state === 'ready' ? '. Click the "Send to Practice Hub" button at the top right of the page.' : C.state === 'sent' ? '. Sent to the hub.'
      : C.state === 'kept' ? '. Read them five at a time with window.__hubCapture.read(1, 5), then read(6, 10) and so on. They stay on this page only. In the review, go(n) opens item n.' : ''}`;
  C.read = (from = 1, to = from + 4) => {
    const got = C.pages.filter(p => p.n >= from && p.n <= to);
    if (!got.length) return `No pages read for items ${from} to ${to}.`;
    return got.map(p => `=== Item ${p.n}${p.id ? ` (Question Id ${p.id})` : ''} ===\n${p.text}${p.marks ? `\n[Marks on the answer choices: ${p.marks}]` : ''}`).join('\n\n');
  };
  const isNum = el => el.children.length === 0 && /^\d{1,2}$/.test(String(el.textContent || '').trim());
  const listItem = n => {
    let best = null, rank = null;
    for (const d of docs()) {
      const row = d.querySelector(`[data-hub-row="${n}"]`);   // a row the review filter marked
      if (row) return [...row.querySelectorAll('*')].find(isNum) || row;
      for (const el of d.querySelectorAll('body *')) {
        if (!isNum(el) || Number(String(el.textContent).trim()) !== n || !shown(el) || el.getBoundingClientRect().left >= 320) continue;
        let up = el.parentElement;
        for (let k = 0; k < 6 && up; k++, up = up.parentElement) {
          const c = [...up.querySelectorAll('*')].filter(isNum).length;
          if (c < 3) continue;
          if (!rank || k < rank[0] || (k === rank[0] && c > rank[1])) { rank = [k, c]; best = el; }
          break;
        }
      }
    }
    return best;
  };
  const itemNow = () => { const it = itemOf(pageText()); return it ? it.n : null; };
  const moved = async from => { for (let w = 0; w < 40; w++) { await sleep(250); if (itemNow() !== from) return true; } return false; };
  C.go = async n => {
    n = Number(n);
    if (!Number.isInteger(n) || n < 1 || n > MAX) return 'Give a question number, like go(5).';
    if (C.state === 'running') return 'Still reading the block: wait until status() says kept.';
    const start = itemNow();
    if (start === n) return `Already on item ${n}.`;
    const el = listItem(n);
    if (el) { el.click(); if (await moved(start) && itemNow() === n) return `Opened item ${n}.`; }
    for (let i = 0; i < MAX; i++) {   // Next or Previous, a page at a time
      const now = itemNow();
      if (now === n) return `Opened item ${n}.`;
      const b = now == null ? null : stepButton(now < n ? 'next' : 'previous');
      if (!b) break;
      b.click();
      if (!await moved(now)) break;
    }
    return `Could not open item ${n}: click ${n} in UWorld's question list on the left.`;
  };
  C.clear = () => { C.pages = []; C.state = 'cleared'; return 'Cleared.'; };
  const b64url = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  C.offer = async () => {
    try {
      if (!C.pages.length) { C.state = 'failed'; C.note = C.note || 'no question pages read'; return C.status(); }
      const body = JSON.stringify({ v: 1, at: Date.now(), total: C.total, pages: C.pages.map(({ key, ...p }) => p) });
      const gz = new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')));
      const href = `${HUB}/uworld-pages.html#z=${b64url(new Uint8Array(await gz.arrayBuffer()))}`;
      let opened = null;
      try { opened = W.open(href, '_blank'); } catch (e) { opened = null; }
      if (opened) { C.pages = []; C.state = 'sent'; return C.status(); }
      const prev = document.getElementById('hubCaptureSend');
      if (prev) prev.remove();
      const a = document.createElement('a');
      a.id = 'hubCaptureSend'; a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = `Send ${C.pages.length} questions to Practice Hub`;
      a.setAttribute('style', 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#5b5bd6;color:#fff;font:600 15px system-ui,sans-serif;padding:12px 16px;border-radius:10px;text-decoration:none;box-shadow:0 4px 16px rgba(0,0,0,.35)');
      // Once clicked, nothing is kept on this page.
      a.addEventListener('click', () => setTimeout(() => { a.remove(); C.pages = []; C.state = 'sent'; }, 800));
      document.body.appendChild(a);
      C.state = 'ready';
    } catch (e) {
      C.state = 'failed'; C.note = `could not pack the pages: ${e && e.message}`;
    }
    return C.status();
  };
  const run = async () => {
    try {
      for (let i = 0; i < MAX; i++) {
        const t = pageText(), before = keyOf(t), it = itemOf(t);
        C.last = C.grab();
        if ((C.total && C.pages.length >= C.total) || (it && it.of && it.n >= it.of)) break;
        const next = nextButton();
        if (!next) { C.note = 'no Next button found: press Next yourself, then grab() on each page, then offer()'; break; }
        next.click();
        let moved = false;
        for (let w = 0; w < 60 && !moved; w++) { await sleep(250); moved = keyOf(pageText()) !== before; }
        if (!moved) { C.note = 'the page did not move on after Next'; break; }
        await sleep(1200 + Math.random() * 1300);   // the explanation renders; a reading pace, never a burst
      }
    } catch (e) {
      C.note = `stopped: ${e && e.message}`;
    }
    if (keep) { C.state = C.pages.length ? 'kept' : 'failed'; if (!C.pages.length) C.note = C.note || 'no question pages read'; return; }
    await C.offer();
  };
  run();
  return 'Started: reading the block one question at a time (2 to 3 s each). Check window.__hubCapture.status() in a minute.';
}

const HUB_DEFAULT = 'https://example.invalid';

export function selfContained(fn, ...args) {
  return `(function () { var __name = function (f) { return f; }; return (${fn.toString()})(${args.map(a => JSON.stringify(a)).join(', ')}); })()`;
}

/** The script Claude in Chrome runs, for the hub at origin. */
export function captureScript(origin = HUB_DEFAULT) {
  const hub = /^https:\/\/[\w.-]+$/.test(String(origin || '')) ? origin : HUB_DEFAULT;
  return selfContained(captureBlock, hub);
}

export const CAPTURE_STEPS = `Send the block (Mo has pressed Stop on the recorder):
1. In the UWorld tab, open this block's review at item 1 if it is not open already.
2. Run script once with javascript_tool on that tab, exactly as given. It steps through every question by itself, 2 to 3 s each.
3. Don't read pages or take screenshots meanwhile. Wait about 45 seconds, then run window.__hubCapture.status() until it says sent or ready.
4. Sent: the hub tab opened by itself, done. Ready: click the "Send to Practice Hub" button it put at the top right (find it).
5. Tell Mo in one line: "Sent N questions. Press Read my times on the recorder."
If the status says no Next button: press Next yourself, run window.__hubCapture.grab() on each question, then window.__hubCapture.offer(), then click the button.`;

/** The script for the chat judge: reads every page and keeps them in the tab for Claude (read(from, to)); sends nothing. */
export function readScript(origin = HUB_DEFAULT) {
  const hub = /^https:\/\/[\w.-]+$/.test(String(origin || '')) ? origin : HUB_DEFAULT;
  return selfContained(captureBlock, hub, 1, true);
}

export function ambossPick(terms, max = 3000) {
  if (!/amboss/i.test(location.hostname)) return 'This is not an AMBOSS page.';
  const want = (Array.isArray(terms) ? terms : []).map(t => String(t).toLowerCase().trim()).filter(t => t.length > 2);
  const root = document.querySelector('main, article, [role="main"]') || document.body;
  if (!root) return 'The page has no text yet.';
  const clean = el => String(el.textContent || '').replace(/\s+/g, ' ').trim();
  const h1 = document.querySelector('h1');
  const title = (h1 && clean(h1)) || document.title || 'AMBOSS';
  const heads = [], out = [], seen = new Set();
  let head = '', used = 0;
  for (const el of root.querySelectorAll('h1, h2, h3, h4, p, li, td, dd')) {
    const t = clean(el);
    if (!t) continue;
    if (/^H[1-4]$/i.test(el.tagName)) { head = t.slice(0, 80); if (!heads.includes(head)) heads.push(head); continue; }
    if (el.querySelector('p, li, td, dd') || seen.has(t)) continue;   // a box of paragraphs: they come on their own
    const low = t.toLowerCase();
    if (want.length && !want.some(w => low.includes(w))) continue;
    seen.add(t);
    const line = `[${head || title}] ${t.length > 600 ? `${t.slice(0, 599)}…` : t}`;
    if (used + line.length > max) break;
    out.push(line);
    used += line.length + 1;
  }
  return `${title}\nSections: ${heads.join(' | ').slice(0, 700)}\n\n${out.length ? out.join('\n') : 'Nothing matched those terms: run it again with the diagnosis or a section name.'}`;
}

/** The AMBOSS reader as a script for javascript_tool: the terms go in the list near its end. */
export function ambossScript(max = 3000) {
  return selfContained(ambossPick, [], max);
}

/** teach_debrief {send: true}: the steps and the script, for the hub this connector runs on. */
export function captureReply(env) {
  return { steps: CAPTURE_STEPS, script: captureScript(env && env.HUB_ORIGIN) };
}

export function focusReview(keepList) {
  if (!/uworld/i.test(location.hostname)) return 'This is not a UWorld page.';
  const root = document.documentElement;
  const order = [...new Set((keepList || []).map(Number).filter(n => n >= 1 && n <= 60))];
  const isNum = el => el.children.length === 0 && /^\d{1,2}$/.test(String(el.textContent || '').trim());
  // The rows of the Question Status list: each lone number down the left edge, climbed to its largest ancestor that
  // holds no other number. Rows marked by an earlier run are found by their mark even when hidden.
  const markRows = () => {
    const found = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isNum(el) || el.closest('[data-hub-row]')) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.left < 320)) continue;
      let cur = el;
      while (cur.parentElement && cur.parentElement !== document.body) {
        const p = cur.parentElement;
        if ([...p.querySelectorAll('*')].filter(isNum).length > 1) break;
        cur = p;
      }
      found.push({ el: cur, n: Number(String(el.textContent).trim()) });
    }
    // The list is the box holding the most of them side by side (a lone number elsewhere, like the "Item: 5 of 20"
    // counter, is not a row): the box marked before, or the parent shared by the most found rows.
    let box = document.querySelector('[data-hub-box]');
    if (!box) {
      const by = new Map();
      for (const f of found) if (f.el.parentElement) by.set(f.el.parentElement, (by.get(f.el.parentElement) || 0) + 1);
      const best = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!best || best[1] < 3) return [];
      box = best[0];
      box.setAttribute('data-hub-box', '');
    }
    for (const f of found) if (f.el.parentElement === box) f.el.setAttribute('data-hub-row', String(f.n));
    return [...box.querySelectorAll(':scope > [data-hub-row]')];
  };
  const apply = () => {
    let list = [];
    try { list = JSON.parse(root.getAttribute('data-hub-focus') || '[]'); } catch (e) { list = []; }
    const rows = markRows();
    let css = document.getElementById('hub-focus-css');
    if (!list.length) { if (css) css.remove(); return { rows, list }; }
    if (!css) { css = document.createElement('style'); css.id = 'hub-focus-css'; (document.head || root).appendChild(css); }
    const shown = list.filter(n => rows.some(r => r.getAttribute('data-hub-row') === String(n)));
    css.textContent = '[data-hub-box]{display:flex!important;flex-direction:column!important}'
      + `[data-hub-row]${shown.map(n => `:not([data-hub-row="${n}"])`).join('')}{display:none!important}`
      + shown.map((n, i) => `[data-hub-row="${n}"]{order:${i + 1}!important}`).join('')
      + '#hub-focus-banner{order:0!important}';
    banner(shown.length);
    return { rows, list: shown };
  };
  function banner(count) {
    const box = document.querySelector('[data-hub-box]');
    let b = document.getElementById('hub-focus-banner');
    if (!box) return;
    if (!b || b.parentElement !== box) {
      if (b) b.remove();
      b = document.createElement('div');
      b.id = 'hub-focus-banner';
      b.setAttribute('style', 'font:600 12px system-ui,sans-serif;padding:6px 8px;background:#5b5bd6;color:#fff;cursor:pointer');
      b.addEventListener('click', () => { root.removeAttribute('data-hub-focus'); const css = document.getElementById('hub-focus-css'); if (css) css.remove(); b.remove(); });
      box.insertBefore(b, box.firstChild);
    }
    b.textContent = `${count} to review, in order · show all`;
  }
  const showAll = () => {
    root.removeAttribute('data-hub-focus');
    const css = document.getElementById('hub-focus-css'); if (css) css.remove();
    const b = document.getElementById('hub-focus-banner'); if (b) b.remove();
  };
  root.setAttribute('data-hub-focus', JSON.stringify(order));
  const { rows, list } = apply();
  if (!rows.length) { showAll(); return 'No Question Status list found on this page.'; }
  // Next, N and the right arrow (P and the left arrow back), added once for the page and reading the list each time.
  if (!root.hasAttribute('data-hub-hooked')) {
    root.setAttribute('data-hub-hooked', '');
    const current = () => {
      let l = [];
      try { l = JSON.parse(root.getAttribute('data-hub-focus') || '[]'); } catch (e) { l = []; }
      return l.filter(n => document.querySelector(`[data-hub-row="${n}"]`));
    };
    const itemNow = () => { const m = /Item:?\s*(\d{1,2})\s*of\s*\d{1,2}/i.exec(document.body ? document.body.innerText : ''); return m ? Number(m[1]) : null; };
    const go = step => {
      markRows();
      const l = current(), now = itemNow();
      if (!l.length || now == null) return false;
      let i = l.indexOf(now), target;
      if (i >= 0) target = l[i + step];
      else { const side = l.filter(n => (step > 0 ? n > now : n < now)); target = step > 0 ? side[0] : side[side.length - 1]; }
      const row = target != null && document.querySelector(`[data-hub-row="${target}"]`);
      if (!row) return false;
      const leaf = [...row.querySelectorAll('*')].find(isNum) || row;
      leaf.click();
      return true;
    };
    const stepOf = el => {
      const b = el && el.closest && el.closest('button, a, [role="button"], [aria-label], [title]');
      if (!b) return 0;
      const said = [b.getAttribute('aria-label'), b.getAttribute('title'), b.innerText].filter(Boolean).map(x => x.replace(/\s+/g, ' ').trim());
      return said.some(x => /^next( question| item)?$/i.test(x)) ? 1 : said.some(x => /^previous( question| item)?$/i.test(x)) ? -1 : 0;
    };
    document.addEventListener('click', e => { const st = stepOf(e.target); if (st && go(st)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    document.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
      const st = /^(n|arrowright)$/i.test(e.key) ? 1 : /^(p|arrowleft)$/i.test(e.key) ? -1 : 0;
      if (st && go(st)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    if (typeof MutationObserver === 'function' && document.body) {
      let timer = null;
      new MutationObserver(() => {
        if (timer || !root.hasAttribute('data-hub-focus')) return;
        timer = setTimeout(() => { timer = null; apply(); }, 250);   // at most four times a second
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  return `Showing ${list.length} of ${rows.length}, in this order: ${list.map(n => `Q${n}`).join(', ')}. Next, N and the right arrow follow it; "show all" on the banner brings the rest back.`;
}

/** The filter as a script for javascript_tool, for these question numbers. */
export function focusScript(keep) {
  const list = [...new Set((keep || []).filter(n => Number.isInteger(n) && n >= 1 && n <= 60))];
  return selfContained(focusReview, list);
}
