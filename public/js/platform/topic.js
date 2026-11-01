import { get, post } from './api.js';
import { h, icon, btn, sheet, dot, bandText, fmtDay, plural, state, errorState, loading, input, field, toast, askClaude } from './kit.js';
import { teachLink } from './teach.js';

const enc = encodeURIComponent;
const BANDS = { strong: 'Strong', good: 'Getting there', mixed: 'Shaky', weak: 'Weak', very_weak: 'Very weak', unseen: 'Not seen yet' };
const BAND_T = { strong: 100, good: 300, mixed: 500, weak: 700, very_weak: 900 };
const RESULT_TONE = r => (/right|good|easy|full/.test(r || '') ? 'ok' : /wrong|again|zero/.test(r || '') ? 'bad' : 'warn');
// The engine's words for a result and where it came from, as a student reads them.
const RESULT_WORD = { right: 'Right', wrong: 'Wrong', partial: 'Partly', flawed: 'Partly right', omitted: 'Left out', again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy',
  gap_stated: 'Gap note', question: 'Question', card: 'Card', lesson: 'Lesson' };
const SOURCE_WORD = { chat: 'Your Claude', voice: 'Your Claude', web: 'In the app', hub_cards: 'Cards', anki: 'Anki', results: 'Results', papers: 'Paper' };
/** A recent result as list cells: the result in words, where it came from, the day (also the Subjects topic sheet). */
export const resultCells = r => [h('span', { class: `status ${RESULT_TONE(r.result)}` }, said(RESULT_WORD, r.result || r.kind)),
  h('span', { class: 'grow' }, r.label || said(SOURCE_WORD, r.source) || said(RESULT_WORD, r.kind)), h('span', { class: 'foot' }, fmtDay(r.day))];
const said = (map, v) => (v == null ? '' : map[v] || String(v).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
const first = (...xs) => xs.find(x => x != null);
const arr = x => (Array.isArray(x) ? x : []);

/**
 * Opens the sheet. hint: {id, name, t1000, band, subject_id, subject_name, section}. ctx: {app, onClose, onTopic(id)}.
 * Returns the sheet.
 */
export function openTopicSheet(hint, ctx = {}) {
  let cur = hint;
  const sh = sheet({ title: hint.name, sub: [hint.subject_name, hint.section].filter(Boolean).join(' · ') || null, wide: true, body: head(hint), onClose: ctx.onClose });
  sh.el.classList.add('topic-sheet');
  const show = t => {
    cur = t;
    sh.el.querySelector('h2').textContent = t.name;
    const sub = sh.el.querySelector('.sub');
    if (sub) sub.textContent = [t.subject_name, t.section].filter(Boolean).join(' · ');
    sh.setBody(head(t), loading(2));
    fill(t);
  };
  async function fill(t) {
    const libOn = !ctx.app || !ctx.app.on || ctx.app.on('library');
    const [k, d, l] = await Promise.allSettled([get(`/api/p/topics/${enc(t.id)}/knowledge`), get(`/api/p/topics/${enc(t.id)}`),
      libOn ? get(`/api/p/library/topic/${enc(t.id)}?build=0`) : Promise.reject(new Error('off'))]);
    if (sh.closed || cur !== t) return;
    const detail = d.status === 'fulfilled' ? d.value : null;
    const know = k.status === 'fulfilled' ? k.value : null;
    if (know && l.status === 'fulfilled' && l.value && !l.value.off) know.library_cov = l.value;
    if (!detail && !know) { sh.setBody(head(t), errorState(d.reason || k.reason, () => show(t))); return; }
    const top = (detail && detail.topic) || {};
    const full = { ...t, ...pick(top, ['name', 'section', 't1000', 'subject_id']), band: top.band || t.band };
    // Pictures (pictures.js), drawn after the rest.
    const pics = h('div');
    import('./pictures.js').then(m => { if (pics.isConnected) pics.replaceWith(m.picturesPart(full, ctx.app)); }).catch(() => {});
    sh.setBody(head(full), checkRow(full, ctx.app), knowledge(know, k.reason, full, id => { const r = arr(know && know.related).find(x => x.id === id); show({ id, name: r ? r.name : 'Topic', subject_name: t.subject_name, band: r && BANDS[r.band] }); if (ctx.onTopic) ctx.onTopic(id); }),
      pics, evidence(detail, full, ctx.app, sh));
  }
  fill(hint);
  return sh;
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] != null).map(k => [k, o[k]]));

function head(t) {
  return h('div', { class: 'tp-head' },
    h('div', { class: 'tp-band' }, dot(t.t1000, true), h('b', null, t.band || bandText(t))),
    teachLink(t));
}

function checkRow(t, app) {
  const viva = h('div', { class: 'foot' });
  const sure = h('div', { class: 'chips tp-sure', role: 'group', 'aria-label': 'How sure are you on this topic today?' });
  let level = null;
  const drawSure = () => sure.replaceChildren(h('span', { class: 'foot' }, 'How sure today?'), ...[['guess', 'Guess'], ['lean', 'Lean'], ['sure', 'Sure']].map(([k, w]) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(level === k), onclick: async () => {
      try { level = (await post(`/api/p/topics/${enc(t.id)}/sure`, { level: level === k ? null : k })).level; drawSure(); } catch (e) { toast(e.message); }
    } }, w)));
  drawSure();
  get(`/api/p/topics/${enc(t.id)}/sure`).then(r => { level = r.level; drawSure(); }).catch(() => {});
  get(`/api/p/topics/${enc(t.id)}/viva`).then(r => {
    const l = r.last;
    viva.textContent = l ? `Last "Tell me what you know" (${fmtDay(l.day)}): ${l.said} of ${l.of} key points.${l.missed.length ? ` Missed: ${l.missed.slice(0, 2).map(m => m.replace(/^\w+: /, '')).join('; ')}.` : ''}` : '';
  }).catch(() => {});
  const google = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent([t.name, t.subject_name].filter(Boolean).join(' '))}`;
  return h('section', { class: 'tp-check' },
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' },
      askClaude(`Tell me what you know: give me a viva on ${t.name}`, 'Tell me what you know', { app, ico: 'chat' }),
      h('a', { class: 'btn btn-gray btn-sm', href: google, target: '_blank', rel: 'noopener' }, icon('search'), 'Pictures on Google')),
    sure, viva);
}

// ------------------------------------------------------------------ What you know
function knowledge(k, err, t, openRelated) {
  const title = h('div', { class: 'section-title tp-title' }, icon('sparkle'), 'What you know');
  if (!k) {
    const off = err && err.status === 404 && !/topic/i.test(err.message || '');
    return h('section', null, title, state('sparkle', off ? 'Not here yet' : 'This did not load', off ? 'Your lessons will show up here once Teach me is switched on.' : (err && err.message) || '', null, true));
  }
  if (k.ready === false) return h('section', null, title, state('sparkle', 'Nothing here yet', 'Tap Teach me. What you learn, in your own words, shows up here.', null, true));
  const s = k.summary || {};
  const words = arr(first(k.in_your_words, k.in_their_words, k.in_his_words));
  const clicked = arr(k.clicked);
  const mis = k.misconceptions || {};
  const met = arr(mis.met), closed = arr(mis.closed);
  const cards = arr(k.cards);
  // Library passages: the library's own coverage of the topic (GET /api/p/library/topic/:id), else what the page cites.
  const cov = k.library_cov;
  const lib = cov ? arr(cov.docs).flatMap(dd => arr(dd.pages).slice(0, 1).map(pg => ({ title: dd.title, page: pg.page }))) : arr(first(k.library, k.citations, k.mehlman));
  const libN = cov ? Number(cov.n) || 0 : lib.length;
  const lost = arr(k.lost_marks);
  const related = arr(k.related);
  const lessons = arr(k.lessons);
  const facts = [
    s.lessons ? plural(s.lessons, 'lesson') : null,
    s.landed ? `${s.landed} landed` : null,
    s.mean_rating != null ? `you rated ${s.mean_rating}/10` : null,
    s.last_day ? `last ${fmtDay(s.last_day).toLowerCase() === 'today' ? 'today' : 'on ' + fmtDay(s.last_day)}` : null,
  ].filter(Boolean);
  const blocks = [];
  if (words.length) blocks.push(group('In your own words', words.map(w => h('blockquote', { class: 'tp-quote' }, h('p', null, w.text), h('span', { class: 'foot' }, fmtDay(w.day))))));
  if (clicked.length) blocks.push(group('What clicked', h('ul', { class: 'tp-list' }, clicked.map(c => h('li', null, c.text)))));
  if (lost.length) {
    blocks.push(group('Where marks went', h('ul', { class: 'tp-list' }, lost.slice(0, 5).map(x => h('li', null,
      x.points ? `In a lesson: ${x.points.join('; ')}` : [x.label || 'A question', x.result ? `: ${said(RESULT_WORD, x.result).toLowerCase()}` : '', x.reason_words ? ` (${x.reason_words})` : ''].join(''),
      x.day ? h('span', { class: 'foot' }, ` · ${fmtDay(x.day)}`) : null)))));
  }
  if (met.length || closed.length) {
    blocks.push(group('Mix-ups', h('ul', { class: 'tp-list' },
      met.map(m => h('li', null, h('span', { class: 'status warn' }, 'Still mixing up'), ' ', m.belief, ' ', notRight('misconception', m.id, m.belief))),
      closed.map(m => h('li', null, h('span', { class: 'status ok' }, 'Sorted'), ' ', m.belief)))));
  }
  const lessonRows = lessons.filter(l => l.outcome || l.mo_rating != null).slice(0, 4);
  if (lessonRows.length) {
    blocks.push(group('Lessons', h('ul', { class: 'list' }, lessonRows.map(l => h('li', null,
      h('span', { class: 'grow' }, l.goal || (l.kind === 'pair' ? 'A look-alike pair' : 'Lesson'), l.final_result ? h('span', { class: 'sub' }, `Exam question: ${l.final_result}`) : null),
      l.mo_rating != null ? h('b', { class: 'num' }, `${l.mo_rating}/10`) : null, h('span', { class: 'foot' }, fmtDay(l.day)))))));
  }
  const tiles = h('div', { class: 'tp-tiles' },
    stat('cards', cards.length ? plural(cards.length, 'card') : 'No cards yet', cards.slice(0, 3).map(c => c.front).filter(Boolean).join(' · ') || 'Lessons make cards as you go.'),
    stat('library', libN ? plural(libN, 'passage') : 'No passages yet', lib.slice(0, 3).map(x => [x.title, x.page != null ? `p.${x.page}` : null].filter(Boolean).join(' ')).join(' · ') || 'From your library, when a lesson cites it.'));
  if (related.length) {
    blocks.push(group('Related', h('div', { class: 'chips' }, related.slice(0, 8).map(r => h('button', { type: 'button', class: 'chip', onclick: () => openRelated(r.id),
      'aria-label': `${r.name}: ${BANDS[r.band] || 'Not seen yet'}` }, dot(BAND_T[r.band] ?? null), h('span', { class: 'nm' }, r.name), h('span', { class: 'bw', 'aria-hidden': 'true' }, BANDS[r.band] || 'Not seen yet'))))));
  }
  const empty = !words.length && !clicked.length && !met.length && !closed.length && !lessonRows.length && !lost.length;
  return h('section', { class: 'tp-know' }, title,
    facts.length ? h('p', { class: 'foot tp-facts' }, facts.join(' · ')) : null,
    empty ? h('p', { class: 'foot' }, `Nothing from a lesson on ${t.name} yet. Tap Teach me: what you explain in your own words and what clicked will show up here.`) : null,
    tiles, ...blocks);
}
function notRight(kind, id, text) {
  if (!id) return null;
  return h('button', { type: 'button', class: 'linkish foot', onclick: e => { e.stopPropagation(); correctSheet(kind, id, text); } }, 'Not right?');
}
function correctSheet(kind, id, text) {
  const words = input({ value: text || '', maxLength: 200, 'aria-label': 'How it really is' });
  const send = async (action, s) => {
    try {
      const r = await post('/api/p/correct', { kind, id, action, ...(action === 'words' ? { words: words.value } : {}) });
      s.close();
      toast(action === 'not_mine' ? 'Taken off your map' : 'Corrected', r.batch_id ? { undo: async () => { await post('/api/p/undo', { batch_id: r.batch_id }); toast('Undone'); } } : undefined);
    } catch (e) { toast(e.message); }
  };
  const mix = kind === 'misconception';
  const s = sheet({ title: 'Not right?', sub: mix ? 'Your Claude noted this as something you mix up. Your word counts over it.' : 'A gap note about you. Your word counts over it.',
    body: h('div', { class: 'form' }, h('blockquote', { class: 'tp-quote' }, h('p', null, text || '')),
      btn(mix ? "That's not what I think" : "That's not right: take it off", () => send('not_mine', s), 'tinted', 'close', { cls: 'btn-block' }),
      field('Or write it the way it really is', words)),
    actions: [btn('Cancel', () => s.close(), 'gray'), btn('Save the words', () => send('words', s), 'primary')] });
}
const group = (label, ...kids) => h('div', { class: 'tp-group' }, h('div', { class: 't-micro' }, label), ...kids);
const stat = (ico, big, small) => h('div', { class: 'tp-stat' }, h('span', { class: 'tile-label' }, icon(ico), big), h('span', { class: 'foot' }, small));

// ------------------------------------------------------------------ results, gap notes and editing
function evidence(d, t, app, sh) {
  if (!d) return null;
  const recent = arr(d.recent);
  const gaps = arr(d.gaps);
  const cardsOn = app && app.on && app.on('cards');
  return h('section', { class: 'tp-evidence' },
    h('div', { class: 't-micro' }, 'Recent results'),
    recent.length
      ? h('ul', { class: 'list' }, recent.slice(0, 6).map(r => h('li', null, ...resultCells(r))))
      : h('p', { class: 'foot' }, 'Nothing logged on this topic yet.'),
    gaps.length ? h('div', null, h('div', { class: 't-micro', style: 'margin:14px 0 8px' }, 'Gap notes'), h('ul', { class: 'list' }, gaps.map(g => h('li', null, h('span', { class: 'grow' }, g.gap), h('span', { class: 'foot' }, fmtDay(g.at)), g.id ? notRight('gap', g.id, g.gap) : null)))) : null,
    h('div', { class: 'row-acts' },
      btn(d.galaxy ? `In ${d.galaxy.title}` : 'Put in a galaxy', () => import('./galaxies.js').then(m => m.chooseGalaxySheet(t, d.galaxy, () => { sh.close(); if (app && app.route) app.route(); })), 'tinted', 'sparkle'),
      cardsOn ? btn(d.cards_n ? `Cards (${d.cards_n})` : 'Make cards', () => { sh.close(); import('./cards.js').then(m => m.draftSheet({ topic_id: t.id, subject_id: t.subject_id, about: t.name })); }, 'tinted', 'cards') : null,
      btn('Paste from Claude', () => import('./chats.js').then(m => m.pasteSheet(app, { topic: { id: t.id, name: t.name } })), 'gray', 'chat'),
      btn('Edit topic', () => { sh.close(); import('./subjects.js').then(m => m.openTopic(t.id, { app, subjectName: t.subject_name })); }, 'gray', 'pencil')));
}
