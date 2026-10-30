// First run (#welcome, after the invite): first a choice, set up by talking to their Claude (connect, then one tap
// starts the interview: setup_guide) or here by hand: 1 subjects and an exam board each (tier for GCSE maths and
// sciences), 2 Suggest topics per subject, 3 Connect your Claude. Every step can be skipped and done later.
import { get, post, patch, del } from './api.js';
import { h, icon, btn, linkBtn, toast, select, seg, loading, errorState, state, busy, copyText, plural, askClaude } from './kit.js';
import { addSubjectSheet, suggestSheet } from './subjects.js';

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

export function render(root, { app, param }) {
  let step = param === 'claude' ? 'claude' : Number(param) || 0;
  const draw = async () => {
    if (step === 0) return chooser(root, app, how => { step = how === 'claude' ? 'claude' : 1; draw(); });
    if (step === 'claude') return withClaude(root, app, () => { step = 0; draw(); });
    root.replaceChildren(header(step), loading(1));
    try {
      if (step === 1) await stepSubjects(root, app, () => { step = 2; draw(); });
      else if (step === 2) await stepTopics(root, app, () => { step = 3; draw(); }, () => { step = 1; draw(); });
      else stepClaude(root, app, () => { step = 2; draw(); });
    } catch (e) { root.replaceChildren(header(step), errorState(e, draw)); }
    window.scrollTo(0, 0);
  };
  draw();
}

// The first screen: how they would like to set up.
function chooser(root, app, pick) {
  const card = (ico, title, sub, how, primary) => h('button', { type: 'button', class: `card wl-pick${primary ? ' on' : ''}`, onclick: () => pick(how) },
    h('span', { class: 'ftype' }, icon(ico)), h('span', { class: 'grow' }, h('b', null, title), h('span', { class: 'sub' }, sub)), icon('chevron', 'chev'));
  root.replaceChildren(h('header', { class: 'head', style: 'display:block' }, h('div', { class: 't-micro kicker' }, 'Welcome'), h('h1', { class: 't-title1' }, 'Let\'s set up your Study Hub')),
    h('p', { class: 'muted', style: 'margin-bottom:16px' }, 'It works for any level, from primary SATs to university. Pick how you would like to set it up.'),
    h('div', { class: 'stack' },
      card('chat', 'Talk to my Claude (recommended)', 'Tell your Claude your subjects, exam boards and latest results. It sets everything up and suggests what to try.', 'claude', true),
      card('grid', 'Set it up here myself', 'Pick your subjects and topics on screen. You can connect your Claude afterwards.', 'here', false)),
    h('div', { class: 'row', style: 'margin-top:16px' }, btn('Skip for now', () => { app.markWelcomed(); app.go('#today'); }, 'plain')));
}

// Set up with their Claude: connect once, then one tap opens a chat that starts the interview.
function withClaude(root, app, back) {
  const out = h('div', { class: 'form' });
  const make = btn('Make my connector link', null, 'primary', 'link', { cls: 'btn-lg' });
  make.addEventListener('click', () => busy(make, async () => {
    try { const r = await post('/api/p/connector', { label: 'Claude' }); make.hidden = true; out.replaceChildren(connectorBox(r.url)); } catch (e) { toast(e.message); }
  }));
  const say = 'Set up my Study Hub with me';
  root.replaceChildren(h('header', { class: 'head', style: 'display:block' }, h('div', { class: 't-micro kicker' }, 'Set up with your Claude'), h('h1', { class: 't-title1' }, 'Two steps')),
    h('section', { class: 'card', style: 'padding:var(--pad);margin-bottom:12px' }, h('b', null, '1. Connect your Claude'),
      h('p', { class: 'foot' }, 'Once only. Already done? Go to step 2.'), h('div', { class: 'form' }, make, out)),
    h('section', { class: 'card', style: 'padding:var(--pad)' }, h('b', null, '2. Start the setup chat'),
      h('p', { class: 'foot' }, 'Your Claude asks one thing at a time: your level, subjects, exam boards, exam dates, latest results and how you like to study. It saves your answers here as you go, then suggests what to try.'),
      h('div', { class: 'row-acts' }, askClaude(say, 'Start in Claude', { cls: 'btn btn-primary btn-lg' }), h('span', { class: 'foot' }, `It says: “${say}”`))),
    footer(btn('Back', back, 'gray', 'back'), btn('Done', () => { app.markWelcomed(); app.go('#today'); }, 'primary', 'check', { cls: 'btn-lg' })));
}

function header(step) {
  const titles = ['Your subjects', 'Your topics', 'Connect your Claude'];
  return h('header', { class: 'head', style: 'display:block' },
    h('div', { class: 'steps', 'aria-hidden': 'true' }, [1, 2, 3].map(i => h('i', { class: i <= step ? 'on' : '' }))),
    h('div', { class: 't-micro kicker' }, `Step ${step} of 3`),
    h('h1', { class: 't-title1' }, titles[step - 1]));
}

function footer(...buttons) {
  return h('div', { class: 'row', style: 'margin-top:20px;justify-content:space-between' }, ...buttons);
}

async function stepSubjects(root, app, next) {
  const [cat, mine] = await Promise.all([get('/api/p/catalogue'), get('/api/p/subjects')]);
  const list = h('div', { class: 'card' });
  const drawList = subjects => {
    list.replaceChildren(...(subjects.length ? subjects.map(s => {
      const c = cat.subjects.find(x => x.id === s.subject);
      const boards = cat.boards.filter(b => !c || c.boards.includes(b.id));
      const save = body => patch(`/api/p/subjects/${encodeURIComponent(s.id)}`, body).then(r => Object.assign(s, r.subject)).catch(e => toast(e.message));
      const remove = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${s.name}`, onclick: async () => {
        subjects = subjects.filter(x => x !== s); drawList(subjects);
        try { await del(`/api/p/subjects/${encodeURIComponent(s.id)}`); toast(`Removed ${s.name}`); } catch (e) { toast(e.message); }
      } }, icon('close'));
      return h('div', { class: 'subj-row' },
        h('div', { class: 'top' }, h('b', { class: 't-head grow' }, s.name), remove),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, 'Exam board', select(boards.map(b => ({ value: b.id, label: b.name })), s.board || 'other', v => save({ board: v }))),
          c && c.tiers ? h('div', { class: 'field' }, 'Tier', seg(c.tiers.map(t => ({ value: t, label: cap(t) })), s.tier || 'higher', v => save({ tier: v }))) : null));
    }) : [state('grid', 'No subjects', 'Add the subjects you are taking.', null, true)]));
  };
  let subjects = mine.subjects;
  drawList(subjects);
  const who = app.me ? h('p', { class: 'foot', style: 'margin-bottom:16px' }, 'Your login name is ', h('b', { style: 'color:var(--ink)' }, app.me.user), '. You need it to sign in on another device.') : null;
  root.replaceChildren(header(1),
    who,
    h('p', { class: 'muted', style: 'margin-bottom:16px' }, `Check your ${cat.track_label} subjects and pick the exam board for each. Not sure? Ask your teacher, or leave it as Other for now.`),
    list,
    h('div', { style: 'margin-top:12px' }, btn('Add a subject', () => addSubjectSheet(app, s => { subjects = [...subjects, s]; drawList(subjects); }), 'tinted', 'plus')),
    footer(btn('Skip setup', () => { app.markWelcomed(); app.go('#today'); }, 'plain'), btn('Next', next, 'primary', 'chevron', { cls: 'btn-lg' })));
}

async function stepTopics(root, app, next, back) {
  const { subjects } = await get('/api/p/subjects');
  const list = h('ul', { class: 'list' });
  const drawRow = s => {
    const li = h('li', null,
      h('span', { class: 'grow' }, h('b', null, s.name), h('span', { class: 'sub' }, s.topics_n ? `${plural(s.topics_n, 'topic')} added` : 'No topics yet')),
      s.topics_n ? h('span', { class: 'status ok' }, icon('check'), 'Done') : null,
      app.on('ai_topics') ? btn(s.topics_n ? 'More' : 'Suggest topics', () => suggestSheet(s, null, async () => {
        try { const r = await get(`/api/p/subjects/${encodeURIComponent(s.id)}`); li.replaceWith(drawRow(r.subject)); } catch { /* keep row */ }
      }), s.topics_n ? 'gray' : 'primary', 'sparkle', { cls: 'btn-sm' }) : null);
    return li;
  };
  list.append(...subjects.map(drawRow));
  root.replaceChildren(header(2),
    h('p', { class: 'muted', style: 'margin-bottom:16px' }, 'For each subject, tap Suggest topics. You will see a revision checklist to tick before anything is added. You can edit topics any time.'),
    subjects.length ? list : state('grid', 'No subjects yet', 'Go back and add a subject first.', null, true),
    footer(btn('Back', back, 'gray', 'back'), btn('Next', next, 'primary', 'chevron', { cls: 'btn-lg' })));
}

function stepClaude(root, app, back) {
  const out = h('div', { class: 'form' });
  const make = btn('Make my connector link', null, 'primary', 'link', { cls: 'btn-lg' });
  make.addEventListener('click', () => busy(make, async () => {
    try {
      const r = await post('/api/p/connector', { label: 'Claude' });
      make.hidden = true;
      out.replaceChildren(connectorBox(r.url), heard);
      // Every 4 s until their Claude first reaches the hub (or they leave this step).
      const t = setInterval(async () => {
        if (!heard.isConnected) { clearInterval(t); return; }
        try {
          const c = await get('/api/p/connector');
          if ((c.links || []).some(l => l.last_used_at)) {
            clearInterval(t);
            heard.className = 'status ok';
            heard.textContent = 'Connected: your Claude just reached your hub. Try: "What are my weakest topics?"';
          }
        } catch { /* keep waiting */ }
      }, 4000);
    } catch (e) { toast(e.message); }
  }));
  const heard = h('p', { class: 'foot', 'aria-live': 'polite' }, 'Waiting for your Claude to connect. This changes once it does.');
  root.replaceChildren(header(3),
    h('p', { class: 'muted', style: 'margin-bottom:16px' }, 'Link Claude to your hub so you can say "gap: ..." or "log my Seneca score" in the Claude app, and ask it to quiz you on your cards.'),
    h('div', { class: 'card', style: 'padding:var(--pad)' }, h('div', { class: 'form' }, make, out)),
    footer(btn('Back', back, 'gray', 'back'), btn('Done', () => { app.markWelcomed(); app.go('#today'); }, 'primary', 'check', { cls: 'btn-lg' })));
}

// The link (shown once), a copy button and the three claude.ai steps. Also used by Settings.
export function connectorBox(url) {
  const code = h('code', null, url);
  const copy = btn('Copy', async () => { toast((await copyText(url)) ? 'Link copied' : 'Could not copy. Press and hold the link to copy it.'); }, 'primary', 'copy', { cls: 'btn-sm' });
  return h('div', { class: 'form' },
    h('div', { class: 'copybox' }, code, copy),
    h('p', { class: 'foot' }, 'This link is shown once and works like a password. Keep it to yourself.'),
    h('ol', { class: 'steplist' },
      h('li', null, 'On claude.ai, open Settings, then Connectors.'),
      h('li', null, 'Tap Add custom connector. Name it Study Hub and paste the link.'),
      h('li', null, 'In a chat, switch Study Hub on from the tools menu. Try: "What are my weakest topics?"')),
    linkBtn('Open claude.ai', 'https://claude.ai/settings/connectors', 'tinted', 'out', true));
}
