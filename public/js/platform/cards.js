// Cards (#cards) and review (#cards/review): the built-in FSRS deck. Review shows the front, Show answer, then
// Again / Hard / Good / Easy (keys 1-4 on an iPad keyboard, space to show; swipe left = Again, right = Good).
// The next card shows at once from the local queue (the rating is sent behind it), topped up from the reply's `next`.
import { get, post, patch, del, load, qs } from './api.js';
import { h, icon, ring, btn, linkBtn, sheet, confirmSheet, toast, field, input, textarea, select, pageHead, loading, errorState, state, busy, plural, fmtDay, askClaude } from './kit.js';

export function render(root, ctx) {
  if (ctx.param === 'review') return renderReview(root, ctx);
  return renderHome(root, ctx);
}

// ------------------------------------------------------------------ home: stats, add, draft, browse
function renderHome(root, { app }) {
  const actions = [btn('Add card', () => addSheet(() => app.route()), 'tinted', 'plus'),
    btn('Draft with AI', () => draftSheet({ onSaved: () => app.route() }), 'gray', 'sparkle')];
  root.append(pageHead('Cards', { actions }), loading(2));
  const statsBox = h('div');
  const listBox = h('div');
  let q = '';
  const search = input({ type: 'search', placeholder: 'Search your cards', enterKeyHint: 'search', 'aria-label': 'Search cards' });
  let timer = 0;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); drawList(); }, 220); });

  const drawStats = s => {
    statsBox.replaceChildren(h('div', { class: 'bento' },
      h('section', { class: 'tile s7' },
        h('div', { class: 'tile-label' }, icon('cards'), 'Due now'),
        h('div', { class: 'fig' }, h('span', { class: 't-display num' }, String(s.due_now)), h('span', { class: 'unit' }, s.due_now === 1 ? 'card' : 'cards'),
          s.due_today > s.due_now ? h('span', { class: 'unit' }, `· ${s.due_today} today`) : null),
        h('div', { class: 'row-acts' }, s.due_now ? linkBtn('Start review', '#cards/review', 'primary', 'play') : h('span', { class: 'status ok' }, icon('check'), 'All caught up'))),
      h('section', { class: 'tile s5', style: 'flex-direction:row;align-items:center;gap:16px' },
        ring(s.total ? (s.review / s.total) : 0, { size: 76, stroke: 8, label: `${s.review} of ${s.total} cards in review`, center: String(s.reviewed_today) }),
        h('div', { class: 'grow' },
          h('div', { class: 't-head' }, `${s.reviewed_today} reviewed today`),
          h('div', { class: 'foot' }, `${plural(s.streak_days, 'day')} in a row`),
          h('div', { class: 'foot' }, `${s.new} new · ${s.learning} learning · ${s.review} in review`)))));
  };
  const drawList = () => {
    listBox.replaceChildren(h('div', { class: 'section-title' }, 'Your cards', h('span', { class: 'aside' })), search, h('div', { style: 'height:12px' }), loading(1));
    get('/api/p/cards' + qs({ q })).then(({ cards }) => {
      const body = cards.length
        ? h('div', { class: 'list' }, cards.map(c => h('button', { type: 'button', class: 'li cv', onclick: () => editSheet(c, drawList) },
          h('span', { class: 'grow' }, h('span', { class: 'clip', style: 'display:block' }, c.front), h('span', { class: 'sub clip' }, c.back)),
          c.suspended ? h('span', { class: 'status na' }, 'Paused') : h('span', { class: 'foot' }, c.state === 'new' ? 'New' : due(c.due_at)),
          icon('chevron', 'chev'))))
        : q ? state('search', 'No cards match', 'Try another word.', null, true)
          : state('cards', 'No cards yet', 'Add one yourself, or let AI draft a few from a topic you find hard.', btn('Add a card', () => addSheet(drawList), 'tinted', 'plus'), true);
      listBox.replaceChildren(h('div', { class: 'section-title' }, 'Your cards', h('span', { class: 'aside foot' }, cards.length ? plural(cards.length, 'card') : '')), search, h('div', { style: 'height:12px' }), body);
    }).catch(e => listBox.replaceChildren(errorState(e, drawList)));
  };
  load('/api/p/cards/stats', s => {
    if (!statsBox.isConnected) root.replaceChildren(pageHead('Cards', { actions, how: 'cards' }), statsBox, listBox);
    drawStats(s);
  }, e => root.replaceChildren(pageHead('Cards', { actions }), errorState(e, () => app.route())));
  drawList();
}

function due(at) {
  const d = at - Date.now();
  if (d <= 0) return 'Due';
  if (d < 864e5) return 'Later today';
  return `In ${Math.round(d / 864e5)} d`;
}

// ------------------------------------------------------------------ review
const RATINGS = [[1, 'Again', 'r1'], [2, 'Hard', 'r2'], [3, 'Good', 'r3'], [4, 'Easy', 'r4']];

function renderReview(root, { app }) {
  let queue = [], current = null, shown = false, done = 0, total = 0, startedAt = 0, dueLeft = 0, waiting = false;
  const back = { href: '#cards', label: 'Cards' };
  root.append(pageHead('Review', { back }), loading(1));

  const prog = h('div', { class: 'progress' });
  // New, learning and review cards left, like Anki's bottom bar; the current card's queue is underlined.
  let counts = { new: 0, learning: 0, review: 0 };
  const countsEl = h('p', { class: 'rv-counts num', 'aria-label': 'Cards left' });
  const setCounts = r => { counts = { new: r.new_n || 0, learning: r.learning_n || 0, review: r.review_n || 0 }; };
  const flash = h('div', { class: 'flash', role: 'button', tabindex: '0', 'aria-live': 'polite' });
  const rate = h('div', { class: 'rate', role: 'group', 'aria-label': 'How well did you know it?' });
  const showBtn = btn('Show answer', () => reveal(), 'primary', null, { cls: 'btn-lg btn-block' });
  const wrap = h('div', { class: 'review' }, prog, countsEl, flash, showBtn, rate);

  function paint() {
    if (!current) return finish();
    const pct = total ? done / total : 0;
    prog.replaceChildren(h('span', { class: 'num' }, `${done + 1} of ${Math.max(total, done + 1)}`), h('div', { class: 'meter' }, (() => { const i = h('i'); i.style.width = `${Math.round(pct * 100)}%`; return i; })()));
    countsEl.replaceChildren(...[['new', 'New'], ['learning', 'Learning'], ['review', 'Review']].flatMap(([k, w], i) => [i ? ' · ' : null,
      h('span', { class: current.queue === k ? 'on' : null }, `${w} ${counts[k]}`)]).filter(Boolean));
    flash.replaceChildren(...[h('div', { class: 'front' }, current.front),
      shown ? h('div', { class: 'answer' }, current.back) : h('div', { class: 'hintline' }, 'Tap the card or press Space to show the answer'),
      shown ? h('div', { class: 'meta' }, current.queue === 'new' ? 'New card' : current.queue === 'learning' ? 'Learning' : 'Review', h('span', { class: 'grow' }), 'Swipe right for Good, left for Again') : null].filter(Boolean));
    flash.style.transform = ''; flash.style.opacity = '';
    showBtn.hidden = shown;
    rate.hidden = !shown;
    rate.replaceChildren(...RATINGS.map(([r, label, cls]) => h('button', { type: 'button', class: cls, onclick: () => rateCard(r) },
      label, current.intervals && current.intervals[r] ? h('small', null, current.intervals[r]) : h('small', null, h('span', { class: 'kbd' }, String(r))))));
  }
  function reveal() { if (!current || shown) return; shown = true; paint(); }
  function rateCard(r) {
    if (!current || !shown) return;
    const card = current, ms = Date.now() - startedAt;
    if (counts[card.queue] > 0) counts[card.queue]--;
    done++;
    current = queue.shift() || null;
    shown = false; startedAt = Date.now();
    if (current) paint(); else { waiting = true; showWaiting(); }
    post(`/api/p/cards/${encodeURIComponent(card.id)}/review`, { rating: r, duration_ms: Math.min(ms, 600000) }).then(res => {
      dueLeft = res.due_n;
      setCounts(res);
      const nx = res.next;
      if (nx && nx.id !== card.id && (!current || nx.id !== current.id) && !queue.some(c => c.id === nx.id)) { queue.push(nx); total = Math.max(total, done + queue.length + (current ? 1 : 0)); }
      if (waiting) { waiting = false; current = queue.shift() || null; startedAt = Date.now(); paint(); }
    }).catch(e => {
      toast(e.message);
      if (waiting) { waiting = false; finish(); }
    });
  }
  function showWaiting() { flash.replaceChildren(h('div', { class: 'hintline' }, 'Checking for more cards…')); showBtn.hidden = true; rate.hidden = true; }
  function finish() {
    root.replaceChildren(pageHead('Review', { back }), h('div', { class: 'review' }, state('check', done ? `All done. ${plural(done, 'card')} reviewed.` : 'Nothing due right now',
      dueLeft ? `${plural(dueLeft, 'card')} will be back later today.` : 'Come back tomorrow, or add a few cards on a weak topic.',
      h('div', { class: 'row', style: 'justify-content:center' }, linkBtn('Back to Cards', '#cards', 'tinted'), linkBtn('Today', '#today', 'gray')))));
  }

  // Swipe on the revealed card: right = Good, left = Again. A tap reveals.
  let x0 = null, dx = 0;
  flash.addEventListener('pointerdown', e => { dx = 0; if (!shown) return; x0 = e.clientX; flash.classList.add('drag'); flash.setPointerCapture(e.pointerId); });
  flash.addEventListener('pointermove', e => { if (x0 == null) return; dx = e.clientX - x0; flash.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`; });
  const end = () => {
    if (x0 == null) return;
    flash.classList.remove('drag'); x0 = null;
    if (Math.abs(dx) > 90) { flash.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`; flash.style.opacity = '0'; const r = dx > 0 ? 3 : 1; setTimeout(() => rateCard(r), 140); }
    else flash.style.transform = '';
  };
  flash.addEventListener('pointerup', end);
  flash.addEventListener('pointercancel', end);
  flash.addEventListener('click', () => { if (Math.abs(dx) < 6) reveal(); });

  const onKey = e => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if ((e.key === ' ' || e.key === 'Enter') && !shown) { e.preventDefault(); reveal(); }
    else if (shown && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); rateCard(Number(e.key)); }
  };
  document.addEventListener('keydown', onKey);

  get('/api/p/cards/due?limit=20').then(r => {
    queue = r.cards.slice(); total = r.due_n; dueLeft = r.due_n; setCounts(r);
    current = queue.shift() || null; startedAt = Date.now();
    if (!current) return finish();
    root.replaceChildren(pageHead('Review', { back }), wrap);
    paint();
  }).catch(e => root.replaceChildren(pageHead('Review', { back }), errorState(e, () => app.route())));

  return () => document.removeEventListener('keydown', onKey);
}

// ------------------------------------------------------------------ add, edit, AI drafts
async function subjectOptions() {
  try { const { subjects } = await get('/api/p/subjects'); return [{ value: '', label: 'No subject' }, ...subjects.map(s => ({ value: s.id, label: s.name }))]; }
  catch { return [{ value: '', label: 'No subject' }]; }
}

function addSheet(done, preset = {}) {
  const front = textarea({ placeholder: 'Question', maxLength: 600, rows: 3, value: preset.front || '' });
  const back = textarea({ placeholder: 'Answer', maxLength: 600, rows: 3, value: preset.back || '' });
  const subjBox = h('div');
  let subject = preset.subject_id || '';
  subjectOptions().then(opts => subjBox.replaceChildren(field('Subject', select(opts, subject, v => { subject = v; }), 'optional')));
  const save = btn('Add card', null, 'primary');
  const sh = sheet({ title: 'New card', body: [field('Front', front), field('Back', back), subjBox], actions: [btn('Cancel', () => sh.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => {
    if (!front.value.trim() || !back.value.trim()) { toast('A card needs a front and a back.'); return; }
    try {
      await post('/api/p/cards', { front: front.value.trim(), back: back.value.trim(), source: 'mine', ...(subject ? { subject_id: subject } : {}), ...(preset.topic_id ? { topic_id: preset.topic_id } : {}) });
      toast('Card added');
      front.value = ''; back.value = '';
      sh.close();
      if (done) done();
    } catch (e) { toast(e.message); }
  }));
}

function editSheet(c, done) {
  const front = textarea({ value: c.front, maxLength: 600, rows: 3 });
  const back = textarea({ value: c.back, maxLength: 600, rows: 3 });
  const save = btn('Save', null, 'primary');
  const pause = btn(c.suspended ? 'Resume' : 'Pause', null, 'gray');
  const remove = btn('Delete', null, 'danger', 'trash');
  const sh = sheet({ title: 'Edit card', sub: c.lapses ? `Forgotten ${plural(c.lapses, 'time')}` : null, body: [field('Front', front), field('Back', back)], actions: [remove, pause, save] });
  save.addEventListener('click', () => busy(save, async () => {
    try { await patch(`/api/p/cards/${encodeURIComponent(c.id)}`, { front: front.value.trim(), back: back.value.trim() }); sh.close(); toast('Card saved'); done(); } catch (e) { toast(e.message); }
  }));
  pause.addEventListener('click', () => busy(pause, async () => {
    try { await patch(`/api/p/cards/${encodeURIComponent(c.id)}`, { suspended: !c.suspended }); sh.close(); toast(c.suspended ? 'Card back in your reviews' : 'Card paused'); done(); } catch (e) { toast(e.message); }
  }));
  remove.addEventListener('click', async () => {
    sh.close();
    if (!(await confirmSheet({ title: 'Delete this card?', sub: 'Its review history goes too. This cannot be undone.', ok: 'Delete', danger: true }))) return;
    try { await del(`/api/p/cards/${encodeURIComponent(c.id)}`); toast('Card deleted'); done(); } catch (e) { toast(e.message); }
  });
}

// AI drafts from a topic (or a gap / some text): previewed with ticks and editable; only ticked ones are saved.
export function draftSheet({ topic_id, subject_id, about, onSaved } = {}) {
  const text = textarea({ placeholder: 'e.g. I keep mixing up mitosis and meiosis', maxLength: 600, rows: 3 });
  const go = btn('Draft cards', null, 'primary', 'sparkle');
  const sh = sheet({ title: about ? `Cards for ${about}` : 'Draft cards with AI', sub: 'AI drafts a few cards. You check and edit them before anything is saved.', wide: true,
    body: topic_id ? [h('p', { class: 'foot' }, 'Drafting from this topic…')] : [field('What do you find hard?', text, 'a gap, a topic or a fact'),
      h('p', { class: 'foot' }, 'Or ask your Claude (it knows your board): ', askClaude(`Make me 5 flashcards on ${about || 'what I find hardest'} and add them to my Study Hub.`, 'Ask my Claude', { cls: 'btn btn-plain btn-sm' }))],
    actions: topic_id ? null : [btn('Cancel', () => sh.close(), 'gray'), go] });
  const run = () => busy(go, async () => {
    const body = topic_id ? { from: 'topic', topic_id, ...(subject_id ? { subject_id } : {}) } : { from: 'gap', text: text.value.trim() };
    if (!topic_id && !body.text) { toast('Write what you find hard first.'); return; }
    sh.setBody(h('div', { class: 'state inline' }, h('div', { class: 'boot', style: 'min-height:60px' }, h('i')), h('p', null, 'Drafting cards…')));
    sh.setActions();
    try {
      const r = await post('/api/p/cards/draft', body);
      const picks = r.drafts.map(d => ({ ...d, on: true }));
      const rows = picks.map(p => {
        const f = textarea({ value: p.front, rows: 2, maxLength: 600, 'aria-label': 'Front' });
        const b = textarea({ value: p.back, rows: 2, maxLength: 600, 'aria-label': 'Back' });
        f.addEventListener('input', () => { p.front = f.value; });
        b.addEventListener('input', () => { p.back = b.value; });
        const tick = h('button', { type: 'button', class: 'tick on', role: 'checkbox', 'aria-checked': 'true', 'aria-label': 'Keep this card', onclick: () => {
          p.on = !p.on; tick.classList.toggle('on', p.on); tick.setAttribute('aria-checked', String(p.on));
        } }, icon('check'));
        return h('div', { class: 'draft' }, h('div', { class: 'row' }, tick, h('div', { class: 'grow form', style: 'gap:8px' }, f, b)));
      });
      const save = btn('Save ticked cards', null, 'primary');
      save.addEventListener('click', () => busy(save, async () => {
        const keep = picks.filter(p => p.on && p.front.trim() && p.back.trim());
        if (!keep.length) { toast('Tick at least one card.'); return; }
        try {
          for (const p of keep) await post('/api/p/cards', { front: p.front.trim(), back: p.back.trim(), source: topic_id ? 'ai' : 'gap', ...(subject_id ? { subject_id } : {}), ...(topic_id ? { topic_id } : {}) });
          sh.close();
          toast(`Saved ${plural(keep.length, 'card')}`);
          if (onSaved) onSaved();
        } catch (e) { toast(e.message); }
      }));
      sh.setBody(rows.length ? rows : state('sparkle', 'No drafts', 'The AI had nothing useful. Try a few more words.', null, true));
      sh.setActions(btn('Cancel', () => sh.close(), 'gray'), save);
    } catch (e) { sh.setBody(errorState(e)); }
  });
  go.addEventListener('click', run);
  if (topic_id) run();
  return sh;
}
export { addSheet };
