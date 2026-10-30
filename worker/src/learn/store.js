import { leaks } from '../checks.js';
import { looksLikeStem } from '../map/guard.js';
import { pairKey } from './context.js';

const TEXT_MAX = 600, LIST_MAX = 8, CITES_MAX = 6;
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
const strs = (v, n = LIST_MAX) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean).slice(0, n);

/** Bullets kept only when every citation is in `allowed` (and there is at least one). */
export function citedOnly(list, allowed) {
  return (Array.isArray(list) ? list : []).map(b => ({ text: clean(b && b.text), cites: [...new Set(strs(b && b.cites, CITES_MAX))] }))
    .filter(b => b.text && b.cites.length && b.cites.every(c => allowed.has(c))).slice(0, LIST_MAX);
}

/** The model's answer with every uncited or unknown claim dropped: {body, cards: [{other_id, ...}]}. */
export function shapeAnswer(data, allowed) {
  const d = data && typeof data === 'object' ? data : {};
  const tested = d.tested || {}, traps = d.traps || {};
  const body = {
    tested: { nbme: citedOnly(tested.nbme, allowed.nbme), cms: citedOnly(tested.cms, allowed.cms), uworld: citedOnly(tested.uworld, allowed.uworld) },
    traps: { mine: citedOnly(traps.mine, allowed.mine), general: strs(traps.general, 5) },
    mehlman: (Array.isArray(d.mehlman) ? d.mehlman : []).map(b => ({ text: clean(b && b.text), pages: [...new Set(strs(b && b.pages, 4))] }))
      .filter(b => b.text && b.pages.length && b.pages.every(p => allowed.pages.has(p))).slice(0, LIST_MAX),
  };
  const seen = new Set();
  const cards = (Array.isArray(d.cards) ? d.cards : []).filter(c => c && allowed.others.has(c.other_id) && !seen.has(c.other_id) && seen.add(c.other_id)).map(c => ({
    other_id: c.other_id, alike: strs(c.alike, 5), why_confused: clean(c.why_confused),
    tell_apart: (Array.isArray(c.tell_apart) ? c.tell_apart : []).map(r => ({ feature: clean(r && r.feature), main: clean(r && r.main), other: clean(r && r.other) }))
      .filter(r => r.feature && (r.main || r.other)).slice(0, LIST_MAX),
    treatment: { main: strs(c.treatment && c.treatment.main, 5), other: strs(c.treatment && c.treatment.other, 5) },
    key_points: strs(c.key_points, 5),
  }));
  return { change_note: clean(d.change_note).slice(0, 160) || null, body, cards };
}

function walk(v, path, out) {
  if (typeof v === 'string') { if (!/\.cites\.\d+$|\.pages\.\d+$|other_id$/.test(path)) out.push([path, v]); return out; }
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
  return out;
}
const keyed = a => ({ change_note: a.change_note, body: a.body, cards: Object.fromEntries(a.cards.map(c => [c.other_id, c])) });

/** The rules an answer breaks, as sentences for the retry ([] when it is clean). */
export function checkAnswer(answer, leakIndex) {
  const errors = [];
  for (const [path, text] of walk(keyed(answer), '', [])) {
    if (looksLikeStem(text)) errors.push(`${path} reads like question text; describe the pattern in your own words.`);
    else { const run = leakIndex && leakIndex.size ? leaks(leakIndex, text) : null; if (run) errors.push(`${path} copies the question ("${run}"); use your own words.`); }
  }
  return errors;
}

/** The answer with every breaking string removed (a bullet or row whose text breaks goes whole). */
export function dropFields(answer, leakIndex) {
  const bad = t => looksLikeStem(t) || !!(leakIndex && leakIndex.size && leaks(leakIndex, t));
  const okB = b => !bad(b.text);
  const okList = l => l.filter(t => !bad(t));
  const a = answer;
  return {
    change_note: a.change_note && !bad(a.change_note) ? a.change_note : null,
    body: {
      tested: { nbme: a.body.tested.nbme.filter(okB), cms: a.body.tested.cms.filter(okB), uworld: a.body.tested.uworld.filter(okB) },
      traps: { mine: a.body.traps.mine.filter(okB), general: okList(a.body.traps.general) },
      mehlman: a.body.mehlman.filter(okB),
    },
    cards: a.cards.map(c => ({ ...c, alike: okList(c.alike), why_confused: bad(c.why_confused) ? '' : c.why_confused,
      tell_apart: c.tell_apart.filter(r => !bad(r.feature) && !bad(r.main) && !bad(r.other)),
      treatment: { main: okList(c.treatment.main), other: okList(c.treatment.other) }, key_points: okList(c.key_points) })),
  };
}

/** A card as stored, from the main topic's side: oriented to the pair (a < b), so it can face either one. */
export function storedCard(mainId, c) {
  const [a] = pairKey(mainId, c.other_id);
  const flip = a !== mainId;
  return { alike: c.alike, why_confused: c.why_confused, key_points: c.key_points,
    rows: c.tell_apart.map(r => ({ feature: r.feature, a: flip ? r.other : r.main, b: flip ? r.main : r.other })),
    treatment: { a: flip ? c.treatment.other : c.treatment.main, b: flip ? c.treatment.main : c.treatment.other } };
}

/** A stored card drawn facing `mainId`: {main, other} in place of {a, b}. */
export function facing(mainId, row) {
  const body = typeof row.body_json === 'string' ? JSON.parse(row.body_json) : row.body_json;
  const flip = row.a_id !== mainId;
  return { other_id: flip ? row.a_id : row.b_id, alike: body.alike || [], why_confused: body.why_confused || '', key_points: body.key_points || [],
    tell_apart: (body.rows || []).map(r => ({ feature: r.feature, main: flip ? r.b : r.a, other: flip ? r.a : r.b })),
    treatment: { main: (body.treatment || {})[flip ? 'b' : 'a'] || [], other: (body.treatment || {})[flip ? 'a' : 'b'] || [] },
    version: Number(row.version) || 1, change_note: row.change_note || null, updated_at: Number(row.updated_at) || null };
}

/** The statements that save one call's summary and cards (one batch with the caller's spend line). */
export function saveStatements(env, user, t, answer, { evMark, trigger, model, usd, now, cardNote = null }) {
  const prev = t.summary;
  const version = (prev ? Number(prev.version) || 1 : 0) + 1;
  const note = answer.change_note || (prev ? 'Updated' : 'First summary');
  const cites = [...new Set([...answer.body.tested.nbme, ...answer.body.tested.cms, ...answer.body.tested.uworld, ...answer.body.traps.mine].flatMap(b => b.cites))];
  const out = [env.DB.prepare(`INSERT INTO learn_summaries (user_id, topic_id, body_json, cites_json, ev_mark, version, change_note, trigger, model, usd, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, topic_id) DO UPDATE SET body_json = excluded.body_json, cites_json = excluded.cites_json,
      ev_mark = excluded.ev_mark, version = excluded.version, change_note = excluded.change_note, trigger = excluded.trigger, model = excluded.model,
      usd = excluded.usd, updated_at = excluded.updated_at`)
    .bind(user, t.topic.id, JSON.stringify(answer.body), JSON.stringify(cites), evMark, version, note, trigger, model, usd, now, now)];
  const cardVersion = new Map(t.cards.map(c => [`${c.a_id}|${c.b_id}`, Number(c.version) || 1]));
  for (const c of answer.cards) {
    const [a, b] = pairKey(t.topic.id, c.other_id);
    const v = (cardVersion.get(`${a}|${b}`) || 0) + 1;
    out.push(env.DB.prepare(`INSERT INTO learn_cards (user_id, a_id, b_id, body_json, version, change_note, model, usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (user_id, a_id, b_id) DO UPDATE SET body_json = excluded.body_json, version = excluded.version, change_note = excluded.change_note,
        model = excluded.model, updated_at = excluded.updated_at`)
      .bind(user, a, b, JSON.stringify(storedCard(t.topic.id, c)), v, v > 1 ? cardNote || 'Updated' : 'First card', model, now, now));
  }
  return out;
}
