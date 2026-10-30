import { h, icon, btn, sheet, toast, busy, field, input, textarea, select, pageHead, loading, errorState, plural, askClaude, confirmSheet, addIcons } from './kit.js';
import { get, post, patch, del } from './api.js';
import { stepsOf, reveal, mark, unmark, current, done, missedOf, rating, whenText } from '../mnemonics/run.js';

addIcons({ bulb: 'p:M9.2 18h5.6M10.2 21h3.6|p:M12 3a6 6 0 0 0-3.7 10.7c.7.6 1.1 1.3 1.1 2.1v.4h5.2v-.4c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3Z' });

const enc = encodeURIComponent;
const REV_AFTER_MS = 20 * 3600_000;   // as worker/src/mnemonics/store.js
const WORD = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

/** New, due or later for one mnemonic now (the server's rule). Pure. */
export function statusOf(m, now = Date.now()) {
  if (!m.fwd) return 'new';
  if (m.fwd.due <= now) return 'due';
  if (m.rev ? m.rev.due <= now : m.fwd.first_at != null && m.fwd.first_at + REV_AFTER_MS <= now) return 'due';
  return 'later';
}
const nextDue = m => Math.min(...[m.fwd, m.rev].filter(Boolean).map(r => r.due));
const itemsList = m => h('ol', { class: `mn-items${m.items.some(i => i.key) ? ' keyed' : ''}` }, m.items.map(i => h('li', null, i.key ? h('b', null, i.key) : null, h('span', null, i.text))));

export function render(root, { app, param }) {
  const page = { subject: param || null, q: '', data: null, run: null };
  root.append(pageHead('Mnemonics'), loading(2));
  let alive = true;

  const load = () => get('/api/p/mnemonics').then(d => { if (!alive) return; page.data = d; if (!page.run) paint(); })
    .catch(e => { if (alive) root.replaceChildren(pageHead('Mnemonics'), errorState(e, () => app.route())); });

  const subjects = () => new Map((page.data.subjects || []).map(s => [s.id, s]));
  const groupOf = m => (m.category_id && subjects().has(m.category_id) ? m.category_id : 'other');
  const matches = m => {
    const words = page.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = [m.cue, m.about, m.notes, ...m.items.map(i => `${i.key} ${i.text}`), ...m.topics.map(t => t.name || '')].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  };

  function card(m, now) {
    const st = statusOf(m, now);
    return h('article', { class: 'mn-card' },
      h('div', { class: 'spread' }, h('h3', { class: 'mn-cue' }, m.cue),
        h('span', { class: `mn-st ${st}` }, st === 'new' ? 'New' : st === 'due' ? 'Due' : `Next ${whenText(nextDue(m), now)}`)),
      h('p', { class: 'mn-about' }, m.about), itemsList(m),
      m.notes ? h('p', { class: 'foot' }, m.notes) : null,
      m.topics.some(t => t.name) ? h('div', { class: 'chips' }, m.topics.filter(t => t.name).map(t => h('span', { class: 'chip' }, t.name))) : null,
      h('div', { class: 'row-acts' },
        btn('Test', () => startTest(m), 'tinted', 'play', { cls: 'btn-sm' }),
        btn('Edit', () => editSheet(m), 'gray', 'pencil', { cls: 'btn-sm' }),
        btn('Remove', () => remove(m), 'gray', 'trash', { cls: 'btn-sm' }),
        m.source === 'claude' ? h('span', { class: 'foot' }, 'Written by your Claude') : null));
  }

  function paint() {
    const now = Date.now(), all = page.data.mnemonics, subs = subjects();
    const nameOf = id => (id === 'other' ? 'Other' : (subs.get(id) || {}).name || id);
    const inSubject = m => !page.subject || groupOf(m) === page.subject;
    const due = all.filter(m => inSubject(m) && statusOf(m, now) === 'due').length;
    const t = page.data.today || { new_done: 0, new_cap: 10 };
    const fresh = Math.min(all.filter(m => inSubject(m) && !m.fwd).length, Math.max(0, t.new_cap - t.new_done));
    const n = due + fresh;
    const head = pageHead('Mnemonics', { kicker: all.length ? `${plural(all.length, 'mnemonic')} · ${due} due${fresh ? ` · ${fresh} new today` : ''}` : 'Memory hooks with their own test', how: 'mnemonics',
      actions: [btn(n ? `Test ${n}` : 'Test', () => startTest(), 'primary', 'play'), btn('Add', () => editSheet(), 'tinted', 'plus')] });
    const ask = askClaude(`Make me 3 mnemonics for my weakest ${page.subject && page.subject !== 'other' ? nameOf(page.subject) : ''} topics and add them to my Study Hub`.replace(/\s+/g, ' '), 'Ask my Claude to write some', { app });
    if (!all.length) {
      root.replaceChildren(head, h('section', { class: 'tile mn-empty' }, h('div', { class: 'tile-label' }, icon('bulb'), 'Your first mnemonic'),
        h('p', null, 'A mnemonic is a hook like PMAT for the stages of mitosis. Each one gets a test: the cue, then every letter in turn. The ones you miss come back sooner.'),
        h('div', { class: 'row-acts' }, btn('Add a mnemonic', () => editSheet(), 'primary', 'plus'), ask)));
      return;
    }
    const groups = [...new Set(all.map(groupOf))].sort((a, b) => (a === 'other') - (b === 'other') || nameOf(a).localeCompare(nameOf(b), 'en-GB'));
    const chip = (id, label, count) => h('a', { class: 'chip', href: id ? `#mnemonics/${enc(id)}` : '#mnemonics', 'aria-pressed': String(page.subject === id), role: 'button' }, label, h('span', { class: 'foot' }, String(count)));
    const search = input({ type: 'search', placeholder: 'Search cues, letters and topics', 'aria-label': 'Search mnemonics', value: page.q, autocomplete: 'off' });
    const list = h('div', { class: 'mn-list' });
    const drawList = () => {
      const shown = all.filter(m => inSubject(m) && matches(m));
      if (!shown.length) { list.replaceChildren(h('p', { class: 'foot' }, `No mnemonics match “${page.q}”.`)); return; }
      list.replaceChildren(...(page.subject ? [page.subject] : groups).map(id => {
        const these = shown.filter(m => groupOf(m) === id);
        return these.length ? h('section', null, h('div', { class: 'section-title' }, `${nameOf(id)} · ${these.length}`), h('div', { class: 'mn-grid' }, these.map(m => card(m, now)))) : null;
      }));
    };
    search.addEventListener('input', () => { page.q = search.value; drawList(); });
    drawList();
    root.replaceChildren(head, h('div', { class: 'search', style: 'margin-bottom:12px' }, icon('search'), search),
      h('div', { class: 'chips', style: 'margin-bottom:14px' }, chip(null, 'All', all.length), groups.map(id => chip(id, nameOf(id), all.filter(m => groupOf(m) === id).length))),
      list, h('div', { class: 'row', style: 'margin-top:16px' }, ask));
  }

  // ---------------------------------------------------------------- add and edit
  async function editSheet(m = null) {
    const subs = page.data ? page.data.subjects : [];
    const cue = input({ maxLength: 60, placeholder: 'PMAT', value: m ? m.cue : '' });
    const about = input({ maxLength: 160, placeholder: 'Stages of mitosis', value: m ? m.about : '' });
    const items = textarea({ rows: 5, placeholder: 'P: Prophase\nM: Metaphase\nA: Anaphase\nT: Telophase', value: m ? m.items.map(i => (i.key ? `${i.key}: ${i.text}` : i.text)).join('\n') : '' });
    const kind = select([{ value: 'acronym', label: 'Letters' }, { value: 'hook', label: 'A hook or story' }, { value: 'rule', label: 'A rule' }], m ? m.kind : 'acronym');
    const subj = select([{ value: '', label: 'From its topics' }, ...subs.map(s => ({ value: s.id, label: s.name }))], m ? m.category_id || '' : page.subject && page.subject !== 'other' ? page.subject : '');
    const notes = textarea({ rows: 2, maxLength: 1500, value: m ? m.notes : '' });
    const chosen = new Map((m ? m.topics : []).filter(t => t.name).map(t => [t.id, t.name]));
    const on = h('div', { class: 'chips' }), q = input({ type: 'search', placeholder: 'Find one of your topics', 'aria-label': 'Find a topic', autocomplete: 'off' }), hits = h('div', { class: 'chips' });
    let topics = [];
    get('/api/p/topics').then(r => { topics = r.topics || []; }).catch(() => {});
    const chips = () => on.replaceChildren(...[...chosen].map(([id, name]) => h('button', { type: 'button', class: 'chip', 'aria-label': `Remove ${name}`, onclick: () => { chosen.delete(id); chips(); } }, `${name} ×`)));
    chips();
    q.addEventListener('input', () => {
      const w = q.value.trim().toLowerCase();
      hits.replaceChildren(...(w.length < 2 ? [] : topics.filter(t => !chosen.has(t.id) && t.name.toLowerCase().includes(w)).slice(0, 6)
        .map(t => h('button', { type: 'button', class: 'chip', onclick: () => { if (chosen.size < 12) { chosen.set(t.id, t.name); chips(); q.value = ''; hits.replaceChildren(); } } }, t.name))));
    });
    const save = btn(m ? 'Save' : 'Add', null, 'primary');
    const s = sheet({ title: m ? `Edit ${m.cue}` : 'Add a mnemonic', wide: true,
      body: h('div', { class: 'form' }, field('Cue', cue), field('What it is for', about), field('Expansion', items, 'one a line; “P: Prophase” keeps the letter'),
        h('div', { class: 'row' }, field('Kind', kind), field('Subject', subj)), field('Topics it covers', h('div', null, on, q, hits)), field('Notes', notes, 'optional')),
      actions: [btn('Cancel', () => s.close(), 'gray'), save] });
    save.addEventListener('click', () => busy(save, async () => {
      const body = { cue: cue.value, about: about.value, items: items.value, kind: kind.value, subject_id: subj.value || null, topics: [...chosen.keys()], notes: notes.value || null };
      try {
        const r = m ? await patch(`/api/p/mnemonics/${enc(m.id)}`, body) : await post('/api/p/mnemonics', body);
        s.close();
        toast(r.nothing ? 'Nothing changed.' : m ? `${body.cue} saved` : `${body.cue} added`, r.batch_id ? { undo: () => undo(r.batch_id) } : undefined);
        load();
      } catch (e) { toast(e.message); }
    }));
  }
  async function undo(batch_id) { await post('/api/p/undo', { batch_id }); toast('Undone'); load(); }
  async function remove(m) {
    if (!(await confirmSheet({ title: `Remove ${m.cue}?`, sub: 'It leaves the list and the test. Undo brings it back with its schedule.', ok: 'Remove', danger: true }))) return;
    try { const r = await del(`/api/p/mnemonics/${enc(m.id)}`); toast(`${m.cue} removed`, { undo: () => undo(r.batch_id) }); load(); } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- the test (run.js)
  async function startTest(only = null) {
    let steps;
    if (only) steps = stepsOf([{ id: only.id, dir: only.fwd || !only.rev ? 'fwd' : 'rev' }], [only]);
    else {
      try {
        const r = await get(`/api/p/mnemonics/test${page.subject ? `?subject=${enc(page.subject)}` : ''}`);
        steps = stepsOf(r.queue, r.mnemonics);
      } catch (e) { toast(e.message); return; }
      if (!steps.length) { toast('Nothing due. New ones come in tomorrow, or test one from its card.'); return; }
    }
    page.run = { steps, i: 0, s: steps[0], easy: false, last: null, results: [] };
    paintTest();
  }
  function endTest() { page.run = null; load(); }

  function paintTest() {
    const run = page.run;
    if (!run) return;
    const bar = h('div', { class: 'mn-t-bar' }, h('span', { class: 'num' }, run.i < run.steps.length ? `${run.i + 1} of ${run.steps.length}` : 'Done'),
      h('div', { class: 'meter grow' }, (() => { const i = h('i'); i.style.width = `${Math.round(100 * run.i / run.steps.length)}%`; return i; })()),
      run.last ? btn('Undo last', undoLast, 'plain', null, { cls: 'btn-sm' }) : null, btn('Stop', endTest, 'plain', null, { cls: 'btn-sm' }));
    if (run.i >= run.steps.length) {
      const by = { again: 0, hard: 0, good: 0, easy: 0 };
      for (const r of run.results) by[r] += 1;
      root.replaceChildren(pageHead('Mnemonics'), h('div', { class: 'mn-test' }, bar, h('section', { class: 'tile mn-t-card' }, h('h2', null, 'Done'),
        h('p', null, `${plural(run.results.length, 'test')}: ${['good', 'easy', 'hard', 'again'].filter(k => by[k]).map(k => `${by[k]} ${WORD[k]}`).join(', ') || 'none'}.`),
        h('div', { class: 'row-acts' }, btn('Back to the list', endTest, 'primary')))));
      return;
    }
    const s = run.s, m = s.m, cur = current(s), fin = done(s), rev = s.dir === 'rev';
    const cls = i => `mn-t-row${(rev ? s.open >= 0 : i <= s.open) ? ' open' : ''}${i === cur ? ' cur' : ''}${s.marks[i] === true ? ' got' : s.marks[i] === false ? ' miss' : ''}`;
    const rows = rev
      ? [h('li', { class: cls(0), onclick: () => act('reveal') }, s.open >= 0 ? [h('b', { class: 'mn-cue' }, m.cue), itemsList(m)] : 'The mnemonic and what it stands for')]
      : m.items.map((it, i) => h('li', { class: cls(i), onclick: () => act('reveal') }, h('b', { class: 'mn-key' }, it.key || String(i + 1)),
        h('span', { class: 'grow' }, i <= s.open ? it.text : '?'), s.marks[i] === true ? h('span', { class: 'foot' }, 'Got it') : s.marks[i] === false ? h('span', { class: 'foot' }, 'Missed') : null));
    const r = fin ? rating(s, run.easy) : null;
    const acts = fin
      ? [h('p', { class: `mn-res ${r}` }, `${WORD[r]}${missedOf(s).length ? ` · missed ${missedOf(s).length} of ${s.total}` : ''}`),
        btn('Next', () => act('next'), 'primary'), !missedOf(s).length ? btn(run.easy ? 'Easy ✓' : 'Easy', () => act('easy'), 'gray') : null,
        missedOf(s).length && m.topics.some(t => t.name) ? btn('Log gap', logGap, 'gray') : null, btn('Change mark', () => act('unmark'), 'plain')]
      : s.open >= cur
        ? [btn('Got it', () => act('got'), 'tinted', 'check', { cls: 'mn-got' }), btn('Missed', () => act('miss'), 'gray', 'close', { cls: 'mn-miss' }), cur > 0 ? btn('Back', () => act('unmark'), 'plain') : null]
        : [btn(`Show ${rev ? 'the mnemonic' : m.items[cur].key || 'next'}`, () => act('reveal'), 'primary'), cur > 0 ? btn('Back', () => act('unmark'), 'plain') : null];
    root.replaceChildren(pageHead('Mnemonics'), h('div', { class: 'mn-test' }, bar, h('section', { class: 'tile mn-t-card', tabindex: '-1' },
      h('p', { class: 't-micro' }, rev ? 'What is the mnemonic?' : m.kind === 'acronym' ? 'Recall each letter' : 'Recall each point'),
      rev ? h('h2', { class: 'mn-big' }, m.about) : [h('h2', { class: 'mn-big' }, m.cue), h('p', { class: 'mn-about' }, m.about)],
      h('ol', { class: 'mn-t-rows' }, rows), fin && m.notes ? h('p', { class: 'foot' }, m.notes) : null,
      h('div', { class: 'row-acts' }, acts))));
  }

  async function next() {
    const run = page.run, s = run.s;
    const body = { dir: s.dir, missed: missedOf(s), easy: run.easy && !missedOf(s).length };
    const r = rating(s, body.easy);
    run.results.push(r); run.i += 1; run.s = run.steps[run.i] || null; run.easy = false;
    paintTest();
    try {
      const res = await post(`/api/p/mnemonics/${enc(s.id)}/rate`, body);
      const fresh = () => ({ ...s, marks: Array(s.total).fill(null), open: -1 });
      // A miss while learning comes back at the end of this test (FSRS brings it back within minutes).
      const again = res.review && res.review.due - Date.now() < 15 * 60_000 && r !== 'good' && r !== 'easy' ? fresh() : null;
      if (again) run.steps.push(again);
      run.last = { batch_id: res.batch_id, step: fresh(), again };
      if (page.run === run) paintTest();
    } catch (e) { toast(e.message || 'That mark did not save.'); }
  }
  async function undoLast() {
    const run = page.run;
    if (!run || !run.last) return;
    const { batch_id, step, again } = run.last;
    run.last = null; paintTest();
    try {
      await post('/api/p/undo', { batch_id });
      if (page.run !== run) return;
      run.results.pop();
      if (again && run.steps.indexOf(again) > run.i) run.steps.splice(run.steps.indexOf(again), 1);
      run.steps.splice(run.i, 0, step); run.s = run.steps[run.i]; run.easy = false;
      paintTest();
    } catch (e) { toast(e.message); }
  }
  async function logGap() {
    const s = page.run.s, m = s.m;
    const missed = missedOf(s).map(i => (s.dir === 'rev' ? m.cue : m.items[i].text));
    try { await post('/api/p/gaps', { gap: `Mnemonic ${m.cue} (${m.about}): forgot ${missed.join(', ')}`.slice(0, 199), topic: (m.topics.find(t => t.name) || {}).id }); toast('Gap logged'); }
    catch (e) { toast(e.message); }
  }
  function act(name) {
    const run = page.run;
    if (!run || !run.s) return;
    if (name === 'reveal') run.s = reveal(run.s);
    else if (name === 'got' || name === 'miss') run.s = mark(run.s, name === 'got');
    else if (name === 'unmark') { run.s = unmark(run.s); run.easy = false; }
    else if (name === 'easy' && done(run.s) && !missedOf(run.s).length) run.easy = !run.easy;
    else if (name === 'next' && done(run.s)) return next();
    paintTest();
  }
  const onKey = e => {
    if (!page.run || e.metaKey || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('input,textarea,select'))) return;
    const s = page.run.s;
    const name = { ' ': s && !done(s) && s.open < current(s) ? 'reveal' : null, 1: 'got', 2: 'miss', Backspace: 'unmark', Enter: s && done(s) ? 'next' : null, e: 'easy', E: 'easy', Escape: 'stop' }[e.key];
    if (!name) return;
    e.preventDefault();
    if (name === 'stop') return endTest();
    if ((name === 'got' || name === 'miss') && s && s.open < current(s)) act('reveal');
    act(name);
  };
  document.addEventListener('keydown', onKey);
  app.onReturn = () => { if (!page.run) load(); };
  load();
  return () => { alive = false; document.removeEventListener('keydown', onKey); };
}
