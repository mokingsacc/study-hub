import { londonDay } from '../util.js';
import { splitByStarts } from '../../../public/js/uworld/split.js';

export const KINDS = ['miss', 'gap', 'uworld_words', 'anki_words', 'lesson', 'teach_note', 'misconception', 'retest', 'mnemonic'];
// What Claude calls a kind (1 Nov 2026: the words Claude reads never say "re-test", so the stored kind 'retest' goes out as
// 'miss_card'); hub_history takes either name.
export const KIND_SHOWN = Object.freeze({ retest: 'miss_card' });
export const SHOWN_KINDS = KINDS.map(k => KIND_SHOWN[k] || k);
export const kindStored = k => Object.keys(KIND_SHOWN).find(s => KIND_SHOWN[s] === k) || k;
export const kindShown = k => KIND_SHOWN[k] || k;
// Where an item came from, in the few words hub_history filters by.
export const SOURCES = ['uworld', 'exam', 'anki', 'chat', 'lesson', 'notes'];
export const TEXT_MAX = 3000, CHUNK_CHARS = 1200;

const clean = s => String(s ?? '').replace(/\((?:read the question|read the card)\)/gi, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const words = s => String(s || '').replace(/_/g, ' ');
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const dayOf = (ms, fallback = null) => (Number(ms) > 0 ? londonDay(Number(ms)) : fallback);
const call = (tool, args) => `${tool} ${JSON.stringify(args)}`;
/** Sentences joined: empty parts left out, each ending in one full stop. */
export function joinText(parts) {
  return cut(parts.map(clean).filter(Boolean).map(p => (/[.!?…:]$/.test(p) ? p : `${p}.`)).join(' '), TEXT_MAX);
}
const field = (name, v) => (clean(v) ? `${name}: ${clean(v)}` : '');
export const daysBack = (day, now) => Math.max(1, Math.min(120, Math.ceil((now - Date.parse(`${day}T12:00:00Z`)) / 86_400_000) + 1));

const QBANK_SOURCE = { uworld: 'uworld', nbme: 'exam', uwsa: 'uworld', free120: 'exam', cms: 'exam', amboss: 'exam' };
const MISS_SOURCE = { hub: 'exam', uworld: 'uworld', anki: 'anki', claude: 'chat', onenote: 'notes' };
export const missSource = r => QBANK_SOURCE[r.qbank] || MISS_SOURCE[r.source] || 'chat';
export const gapSource = r => (r.source === 'chat' ? 'chat' : r.source === 'spoken_cue' && /^uw:/.test(String(r.ref || '')) ? 'uworld' : 'anki');

// ------------------------------------------------------------------ the sources read by watermark

// Each: sql binds ?1 user, ?2 stamp, ?3 id, ?4 limit, ordered by stamp then id; live(r) false: the item leaves.
const MISS_SQL = `SELECT m.id, m.updated_at AS stamp, m.source, m.qbank, m.label, m.day, m.at, m.result, m.flaw_kind, m.confidence, m.error_type, m.step,
    m.time_s, m.slow, m.topic_raw, m.condition_raw, m.system_raw, m.topic_id, m.category_id, m.rule, m.my_reasoning, m.look_alikes,
    m.look_alike_names_json, m.learning_point, m.held, m.deleted_at, t.name AS topic_name
  FROM misses m LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id
  WHERE m.user_id = ?1 AND (m.updated_at > ?2 OR (m.updated_at = ?2 AND m.id > ?3)) ORDER BY m.updated_at, m.id LIMIT ?4`;
// gaps has no updated_at: new rows by rowid here (a re-saved cue is a new row), and changes by the reconcile's re-check.
const GAP_COLS = `g.id, g.at, g.day, g.source, g.card_id, g.ref, g.topic, g.gap, g.said, g.error_type, g.verdict, g.topic_id, g.held, g.mixed_with,
    g.step, g.confidence, t.name AS topic_name, t.category_id`;
const GAP_SQL = `SELECT g.rowid AS stamp, ${GAP_COLS} FROM gaps g LEFT JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id
  WHERE g.user_id = ?1 AND (g.rowid > ?2 OR (g.rowid = ?2 AND g.id > ?3)) ORDER BY g.rowid, g.id LIMIT ?4`;
export const GAPS_LIVE_SQL = `SELECT ${GAP_COLS} FROM gaps g LEFT JOIN topics t ON t.user_id = g.user_id AND t.id = g.topic_id
  WHERE g.user_id = ?1 AND g.held = 0 ORDER BY g.at`;
const LESSON_SQL = `SELECT l.id, l.updated_at AS stamp, l.topic_id, l.topic_name, l.kind, l.status, l.day, l.ended_at, l.started_at, l.created_at, l.goal,
    l.weak_spot, l.what_clicked, l.mo_rating, l.mo_rating_why, l.outcome, l.teach_back_text, l.teach_back_json, l.final_explain_json, l.claude_view_json,
    t.category_id, (SELECT n.body FROM topic_notes n WHERE n.user_id = l.user_id AND n.source_ref = 'lesson:' || l.id AND n.kind = 'lesson_summary'
      AND n.status = 'active' LIMIT 1) AS summary
  FROM lessons l LEFT JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
  WHERE l.user_id = ?1 AND (l.updated_at > ?2 OR (l.updated_at = ?2 AND l.id > ?3)) ORDER BY l.updated_at, l.id LIMIT ?4`;
const MEMORY_SQL = `SELECT m.id, m.updated_at AS stamp, m.scope, m.scope_ref, m.tactic, m.note, m.status, m.created_at, t.name AS topic_name, t.category_id
  FROM teach_memory m LEFT JOIN topics t ON t.user_id = m.user_id AND m.scope = 'topic' AND t.id = m.scope_ref
  WHERE m.user_id = ?1 AND (m.updated_at > ?2 OR (m.updated_at = ?2 AND m.id > ?3)) ORDER BY m.updated_at, m.id LIMIT ?4`;
const MISC_SQL = `SELECT c.id, c.updated_at AS stamp, c.topic_id, c.topic_name, c.belief, c.words, c.ref, c.status, c.first_seen, c.last_seen, c.seen_n,
    c.closed_by, c.note, t.category_id
  FROM misconceptions c LEFT JOIN topics t ON t.user_id = c.user_id AND t.id = c.topic_id
  WHERE c.user_id = ?1 AND (c.updated_at > ?2 OR (c.updated_at = ?2 AND c.id > ?3)) ORDER BY c.updated_at, c.id LIMIT ?4`;
const RETEST_SQL = `SELECT r.id, r.updated_at AS stamp, r.kind AS rkind, r.miss_id, r.lesson_id, r.topic_id, r.due, r.result, r.done_at, r.done_by, r.created_at,
    m.label AS miss_label, m.day AS miss_day, m.held AS miss_held, m.deleted_at AS miss_deleted, m.qbank, m.source AS miss_source,
    coalesce(t.name, m.topic_raw, l.topic_name) AS topic_name, t.category_id
  FROM retests r LEFT JOIN misses m ON m.user_id = r.user_id AND m.id = r.miss_id LEFT JOIN lessons l ON l.user_id = r.user_id AND l.id = r.lesson_id
    LEFT JOIN topics t ON t.user_id = r.user_id AND t.id = r.topic_id
  WHERE r.user_id = ?1 AND (r.updated_at > ?2 OR (r.updated_at = ?2 AND r.id > ?3)) ORDER BY r.updated_at, r.id LIMIT ?4`;
const MNEMONIC_SQL = `SELECT x.id, x.updated_at AS stamp, x.cue, x.about, x.kind, x.items_json, x.topics_json, x.category_id, x.notes, x.created_at, x.deleted_at
  FROM mnemonics x WHERE x.user_id = ?1 AND (x.updated_at > ?2 OR (x.updated_at = ?2 AND x.id > ?3)) ORDER BY x.updated_at, x.id LIMIT ?4`;

// ------------------------------------------------------------------ items (pure)

export function missItem(r) {
  const names = parse(r.look_alike_names_json, []).filter(x => typeof x === 'string');
  const how = [r.result === 'flawed' ? `right for a flawed reason${r.flaw_kind ? ` (${words(r.flaw_kind)})` : ''}` : 'wrong', words(r.error_type),
    r.confidence && `${r.confidence}`, r.step && `step ${r.step}`, r.slow ? `slow${r.time_s ? ` (${r.time_s} s)` : ''}` : ''].filter(Boolean).join(', ');
  const topic = r.topic_name || r.topic_raw || null;
  return {
    key: `miss:${r.id}`, kind: 'miss', src_id: r.id, day: r.day, at: r.at, source: missSource(r), label: r.label, topic_id: r.topic_id || null, topic,
    category_id: r.category_id || null, system: r.system_raw || null,
    text: joinText([`${r.label}: ${[topic, r.condition_raw && r.condition_raw !== topic ? r.condition_raw : null].filter(Boolean).join(' / ')}, ${how}`,
      field('His reasoning', r.my_reasoning), field('Rule', r.rule), field('Look-alikes', [r.look_alikes, ...names].filter(Boolean).join('; ')),
      field('Learning point', r.learning_point)]),
    open: call('board_error_log', { query: r.label, since_day: r.day, detail: true }),
  };
}
export const missLive = r => !Number(r.held) && r.deleted_at == null;

export function gapItem(r) {
  const topic = r.topic_name || r.topic || null;
  const extra = [r.mixed_with && `mixed up with ${r.mixed_with}`, r.step && `step ${r.step}`, r.confidence, words(r.error_type), r.verdict === 'shaky' ? 'shaky' : ''].filter(Boolean).join(', ');
  return {
    key: `gap:${r.id}`, kind: 'gap', src_id: r.id, day: r.day, at: r.at, source: gapSource(r), label: r.ref && !/^(uw|anki):/.test(r.ref) ? r.ref : r.card_id ? `Anki card ${r.card_id}` : 'Gap',
    topic_id: r.topic_id || null, topic, category_id: r.category_id || null, system: null,
    text: joinText([`Gap${topic ? ` on ${topic}` : ''}: ${clean(r.gap)}`, field('He said', r.said), extra]),
    // list_gaps reads back from today: its days are counted when a search answers (openAt), so the stored item never ages.
    open: r.card_id ? call('anki_words', { card_id: Number(r.card_id) }) : 'list_gaps',
  };
}
export const gapLive = r => !Number(r.held);
/** A stored open as it is answered: a gap's list_gaps with the days that reach back to its day. */
// A row indexed before 1 Nov 2026 still names map_weakest's old purpose; it goes out under the new name.
export const openAt = (open, day, now = Date.now()) => (open === 'list_gaps' ? call('list_gaps', { since_days: daysBack(day, now) })
  : typeof open === 'string' ? open.replace('{"purpose":"retest"}', '{"purpose":"miss_cards"}') : open);

const LESSON_DONE = ['done', 'abandoned'];
export function lessonItem(r) {
  const tb = parse(r.teach_back_json, {}) || {}, fe = parse(r.final_explain_json, {}) || {}, cv = parse(r.claude_view_json, {}) || {};
  const missing = list => (Array.isArray(list) && list.length ? list.filter(x => typeof x === 'string').join('; ') : '');
  const day = r.day || dayOf(r.ended_at || r.started_at || r.created_at);
  return {
    key: `lesson:${r.id}`, kind: 'lesson', src_id: r.id, day, at: r.ended_at || r.started_at || r.created_at, source: 'lesson',
    label: `${r.kind === 'lesson' ? 'Lesson' : r.kind === 'patch' ? 'Patch lesson' : 'Pair lesson'} ${day || ''}`.trim(), topic_id: r.topic_id || null, topic: r.topic_name || null,
    category_id: r.category_id || null, system: null,
    text: joinText([`${r.status === 'abandoned' ? 'Stopped lesson' : 'Lesson'} on ${r.topic_name || 'a topic'}${r.outcome ? `: ${words(r.outcome)}` : ''}`,
      r.mo_rating != null ? `Mo rated it ${r.mo_rating}/10${clean(r.mo_rating_why) ? `: ${clean(r.mo_rating_why)}` : ''}` : '',
      field('Goal', r.goal), field('Weak spot', r.weak_spot), field('What clicked', r.what_clicked), field('Teach-back', r.teach_back_text),
      field('Teach-back missed', missing(tb.missing)), field('Final case missed', missing(fe.missing)), field('Claude', cv.reasons), field('Summary', r.summary)]),
    open: r.topic_id ? call('map_topic', { topic: r.topic_id, include: ['lessons'] }) : call('teach_next', { peek: true }),
  };
}
export const lessonLive = r => LESSON_DONE.includes(r.status);

export function memoryItem(r) {
  const topic = r.scope === 'topic' ? (r.topic_name || r.scope_ref) : null;
  return {
    key: `teach_note:${r.id}`, kind: 'teach_note', src_id: r.id, day: dayOf(r.created_at), at: r.created_at, source: 'lesson',
    label: `Teaching note (${words(r.tactic)})`, topic_id: r.scope === 'topic' ? r.scope_ref : null, topic, category_id: r.scope === 'category' ? r.scope_ref : r.category_id || null, system: null,
    text: joinText([`How to teach Mo (${words(r.tactic)}${r.scope !== 'global' ? `, ${r.scope}${r.scope_ref ? ` ${topic || r.scope_ref}` : ''}` : ''}): ${clean(r.note)}`]),
    open: call('teach_memory_list', r.scope === 'topic' && r.scope_ref ? { scope: 'topic', topic: r.scope_ref } : { scope: r.scope }),
  };
}
export const memoryLive = r => r.status !== 'retired';

export function miscItem(r) {
  return {
    key: `misconception:${r.id}`, kind: 'misconception', src_id: r.id, day: dayOf(r.last_seen || r.first_seen), at: r.last_seen || r.first_seen, source: 'lesson',
    label: r.ref ? `Misconception (${r.ref})` : 'Misconception', topic_id: r.topic_id || null, topic: r.topic_name || null, category_id: r.category_id || null, system: null,
    text: joinText([`Wrong belief${r.topic_name ? ` on ${r.topic_name}` : ''}${r.words === 'mo' ? ' (his words)' : ''}: ${clean(r.belief)}`,
      `${r.status}${r.seen_n > 1 ? `, seen ${r.seen_n} times` : ''}${r.closed_by ? `, closed by ${r.closed_by}` : ''}`, field('Note', r.note)]),
    open: r.topic_id ? call('map_topic', { topic: r.topic_id, include: ['lessons'] }) : call('teach_memory_list', { scope: 'all' }),
  };
}

const RETEST_WORD = { got_it: 'got it', missed_again: 'missed again' };
export function retestItem(r) {
  const what = r.rkind === 'lesson' ? `the lesson on ${r.topic_name || 'a topic'}` : r.miss_label || 'a miss';
  const done = r.result ? `${RETEST_WORD[r.result] || r.result}${r.done_at ? ` on ${dayOf(r.done_at)}` : ''}${r.done_by ? ` (${r.done_by})` : ''}` : 'not done yet';
  return {
    key: `retest:${r.id}`, kind: 'retest', src_id: r.id, day: r.result ? dayOf(r.done_at, r.due) : r.due, at: r.done_at || r.created_at,
    source: r.rkind === 'lesson' ? 'lesson' : missSource({ qbank: r.qbank, source: r.miss_source }), label: `Card from ${r.miss_label || what}`,
    topic_id: r.topic_id || null, topic: r.topic_name || null, category_id: r.category_id || null, system: null,
    text: joinText([`Card from ${what}${r.topic_name && r.rkind !== 'lesson' ? ` (${r.topic_name})` : ''}, due ${r.due}: ${done}`]),
    open: r.miss_label ? call('board_error_log', { query: r.miss_label, since_day: r.miss_day || r.due, detail: true }) : call('map_weakest', { purpose: 'miss_cards' }),
  };
}
export const retestLive = r => (r.rkind !== 'miss' || (r.miss_label != null && !Number(r.miss_held) && r.miss_deleted == null));

export function mnemonicItem(r) {
  const items = parse(r.items_json, []).map(x => (x && typeof x === 'object' ? [x.key, x.text].filter(Boolean).join(' ') : '')).filter(Boolean);
  const topics = parse(r.topics_json, []).filter(x => typeof x === 'string');
  return {
    key: `mnemonic:${r.id}`, kind: 'mnemonic', src_id: r.id, day: dayOf(r.created_at), at: r.created_at, source: 'notes', label: `Mnemonic ${cut(clean(r.cue), 40)}`,
    topic_id: topics[0] || null, topic: clean(r.about) || null, category_id: r.category_id || null, system: null,
    text: joinText([`${clean(r.cue)}: ${clean(r.about)}`, items.join('; '), field('Notes', r.notes)]),
    open: call('mnemonics_list', { query: cut(clean(r.cue), 40) }) + ' (Notes connector)',
  };
}
export const mnemonicLive = r => r.deleted_at == null;

// The watermark sources: {kind, sql, item, live}.
export const WATERMARK = [
  { kind: 'miss', sql: MISS_SQL, item: missItem, live: missLive },
  { kind: 'gap', sql: GAP_SQL, item: gapItem, live: gapLive },
  { kind: 'lesson', sql: LESSON_SQL, item: lessonItem, live: lessonLive },
  { kind: 'teach_note', sql: MEMORY_SQL, item: memoryItem, live: memoryLive },
  { kind: 'misconception', sql: MISC_SQL, item: miscItem, live: () => true },
  { kind: 'retest', sql: RETEST_SQL, item: retestItem, live: retestLive },
  { kind: 'mnemonic', sql: MNEMONIC_SQL, item: mnemonicItem, live: mnemonicLive },
];


// A block's stamp is its own updated_at or its judging's newest, whichever is later (binds ?1 user, ?2 stamp, ?3 id, ?4 limit).
export const BLOCK_SQL = `SELECT * FROM (SELECT b.id, b.day, b.created_at, b.segments_json, b.manual_json, b.questions_json,
    max(b.updated_at, coalesce((SELECT max(r.updated_at) FROM uworld_reviews r WHERE r.user_id = ?1 AND r.block_id = b.id), 0)) AS stamp FROM uworld_blocks b)
  WHERE stamp > ?2 OR (stamp = ?2 AND id > ?3) ORDER BY stamp, id LIMIT ?4`;
export const REVIEWS_SQL = `SELECT block_id, q, uworld_id, pile, verdict, error_type, why, quote, topic_id FROM uworld_reviews
  WHERE user_id = ?1 AND block_id IN (SELECT value FROM json_each(?2))`;

const segText = segs => clean((segs || []).map(s => s && s.text).join(' '));

/** A block's items: one per question when its split is saved (its words, results-screen labels and the judge's note), else its words in chunks. */
export function blockItems(b, reviews = []) {
  const segs = parse(b.segments_json, []), questions = parse(b.questions_json, []).filter(q => q && Number.isInteger(q.q));
  const byQ = new Map(reviews.map(r => [r.q, r]));
  const out = [];
  const starts = questions.filter(q => Number.isFinite(q.start_ms));
  if (starts.length) {
    const { groups } = splitByStarts(segs, starts);
    for (const q of questions) {
      const said = segText(groups.get(q.q) || []);
      const rv = byQ.get(q.q) || {};
      const head = [q.result, q.verdict && `check ${words(q.verdict)}`, words(q.error_type || rv.error_type), rv.pile && rv.pile !== q.verdict ? `judged ${rv.pile}` : '',
        q.time_s ? `${q.time_s} s` : ''].filter(Boolean).join(', ');
      if (!said && !clean(q.note) && !clean(rv.why)) continue;
      const id = q.uworld_id || rv.uworld_id;
      out.push({
        key: `uworld_words:${b.id}:${q.q}`, kind: 'uworld_words', src_id: b.id, day: b.day, at: Number(b.created_at) + (Number(q.start_ms) || 0), source: 'uworld',
        label: id ? `UW ${id}` : `UWorld ${b.day} Q${q.q}`, topic_id: rv.topic_id || null, topic: q.topic || null, category_id: null, system: q.system || null,
        text: joinText([`UWorld Q${q.q}${id ? ` (UW ${id})` : ''}${q.topic ? `, ${q.topic}` : ''}${head ? `: ${head}` : ''}`, field('His words', said),
          field('Check', q.note), field('Judge', rv.why)]),
        open: call('uworld_words', { block: b.id, question: q.q }),
      });
    }
    return out;
  }
  let buf = '', n = 0;
  const flush = () => {
    if (!buf) return;
    out.push({ key: `uworld_words:${b.id}:c${n}`, kind: 'uworld_words', src_id: b.id, day: b.day, at: Number(b.created_at) + n, source: 'uworld',
      label: `UWorld block ${b.day}`, topic_id: null, topic: null, category_id: null, system: null,
      text: joinText([`UWorld block ${b.day}, his words (part ${n + 1})`, buf]), open: call('uworld_words', { block: b.id }) });
    n++;
    buf = '';
  };
  for (const s of segs) {
    const t = clean(s && s.text);
    if (!t) continue;
    buf = buf ? `${buf} ${t}` : t;
    if (buf.length >= CHUNK_CHARS) flush();
  }
  flush();
  return out;
}

export const SESSION_SQL = `SELECT id, day, device, status, updated_at AS stamp FROM anki_sessions
  WHERE (updated_at > ?1 OR (updated_at = ?1 AND id > ?2)) ORDER BY updated_at, id LIMIT ?3`;
export const CARDS_SQL = `SELECT session_id, n, card_id, note_id, deck, shown_at, ease, before_json, after_json, words, verdict, error_type, gap, said, topic
  FROM anki_cards WHERE session_id IN (SELECT value FROM json_each(?1)) AND (words > 0 OR verdict IN ('gap', 'shaky')) ORDER BY session_id, n`;
const EASE = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

export function cardItem(c, s) {
  const before = segText(parse(c.before_json, [])), after = segText(parse(c.after_json, []));
  const check = [EASE[c.ease] && `rated ${EASE[c.ease]}`, c.verdict && c.verdict !== 'pending' ? `check ${words(c.verdict)}` : '', words(c.error_type)].filter(Boolean).join(', ');
  return {
    key: `anki_words:${c.session_id}:${c.n}`, kind: 'anki_words', src_id: c.session_id, day: s.day, at: c.shown_at || null, source: 'anki',
    label: `Anki card ${c.card_id}`, topic_id: null, topic: c.topic || null, category_id: null, system: null,
    text: joinText([`Anki card ${c.card_id}${c.deck ? ` (${c.deck})` : ''}${c.topic ? `, ${c.topic}` : ''}${check ? `: ${check}` : ''}`, field('Before the answer', before),
      field('After', after), field('Gap', c.gap), field('He said', c.said)]),
    open: call('anki_words', { card_id: Number(c.card_id) }),
  };
}

// ------------------------------------------------------------------ the reconcile: what has left its source

// One DELETE per kind: an item whose source row is gone, held, deleted or no longer counted (binds ?1 user).
export const GONE_SQL = {
  miss: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'miss' AND NOT EXISTS (SELECT 1 FROM misses m
    WHERE m.user_id = history_items.user_id AND m.id = history_items.src_id AND m.held = 0 AND m.deleted_at IS NULL)`,
  gap: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'gap' AND NOT EXISTS (SELECT 1 FROM gaps g
    WHERE g.user_id = history_items.user_id AND g.id = history_items.src_id AND g.held = 0)`,
  lesson: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'lesson' AND NOT EXISTS (SELECT 1 FROM lessons l
    WHERE l.user_id = history_items.user_id AND l.id = history_items.src_id AND l.status IN ('done', 'abandoned'))`,
  teach_note: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'teach_note' AND NOT EXISTS (SELECT 1 FROM teach_memory m
    WHERE m.user_id = history_items.user_id AND m.id = history_items.src_id AND m.status != 'retired')`,
  misconception: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'misconception' AND NOT EXISTS (SELECT 1 FROM misconceptions c
    WHERE c.user_id = history_items.user_id AND c.id = history_items.src_id)`,
  retest: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'retest' AND NOT EXISTS (SELECT 1 FROM retests r
    WHERE r.user_id = history_items.user_id AND r.id = history_items.src_id AND (r.kind != 'miss' OR EXISTS (SELECT 1 FROM misses m
      WHERE m.user_id = r.user_id AND m.id = r.miss_id AND m.held = 0 AND m.deleted_at IS NULL)))`,
  mnemonic: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'mnemonic' AND NOT EXISTS (SELECT 1 FROM mnemonics x
    WHERE x.user_id = history_items.user_id AND x.id = history_items.src_id AND x.deleted_at IS NULL)`,
  uworld_words: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'uworld_words' AND NOT EXISTS (SELECT 1 FROM uworld_blocks b WHERE b.id = history_items.src_id)`,
  anki_words: `DELETE FROM history_items WHERE user_id = ?1 AND kind = 'anki_words' AND NOT EXISTS (SELECT 1 FROM anki_sessions s WHERE s.id = history_items.src_id)`,
};
