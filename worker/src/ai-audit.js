
import { coreAudit } from './answer-core.js';
import { noteTrace } from './debug/trace.js';

const KEEP_MS = 30 * 86_400_000, FAILING_MAX = 20;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/** Text as compared for quotes (pure): lower case, accents, apostrophes and punctuation off, single spaces. */
export const normText = s => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// How many of the quote's words come in order inside a stretch of the source starting at i, a few words longer than
// the quote (the longest common subsequence; pure).
function inOrder(q, src, i) {
  const w = src.slice(i, Math.min(src.length, i + q.length + 3));
  let prev = new Array(w.length + 1).fill(0);
  for (let a = 1; a <= q.length; a++) {
    const cur = new Array(w.length + 1).fill(0);
    for (let b = 1; b <= w.length; b++) cur[b] = q[a - 1] === w[b - 1] ? prev[b - 1] + 1 : Math.max(prev[b], cur[b - 1]);
    prev = cur;
  }
  return prev[w.length];
}

export function quoteFound(quote, source) {
  const raw = String(quote == null ? '' : quote).trim();
  if (!raw) return true;
  const hay = ` ${normText(Array.isArray(source) ? source.join(' ') : source)} `;
  if (hay.trim() === '') return false;
  const toks = hay.trim().split(' ');
  const parts = raw.split(/…|\.{3}/).map(normText).filter(Boolean);
  if (!parts.length) return true;
  return parts.every(p => {
    if (hay.includes(` ${p} `)) return true;
    const q = p.split(' ');
    if (q.length < 6) return false;
    const need = Math.ceil(q.length * 0.85);
    for (let i = 0; i < toks.length; i++) if ((toks[i] === q[0] || toks[i] === q[1]) && inOrder(q, toks, i) >= need) return true;
    return false;
  });
}

const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const filled = v => v != null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'string' && !v.trim());

export function checkItem(item, { id, required = [], quotes = [], source = '' }) {
  const produced = required.filter(p => filled(get(item, p)));
  const missing = required.filter(p => !filled(get(item, p)));
  const fake = quotes.filter(p => filled(get(item, p)) && !quoteFound(get(item, p), source));
  return { id: String(id), required, produced, missing, fake, ok: !missing.length && !fake.length };
}

export function dropFake(item, row) {
  if (!row || !row.fake.length) return item;
  const out = JSON.parse(JSON.stringify(item));
  for (const p of row.fake) {
    const keys = p.split('.');
    const last = keys.pop();
    const host = keys.reduce((v, k) => (v == null ? v : v[k]), out);
    if (host && typeof host === 'object') host[last] = typeof host[last] === 'string' ? '' : null;
  }
  return out;
}

const PART_WORD = { quote: 'a real quote', cause: 'a cause', step: 'a step', why: 'a why', rule: 'a rule', entry: 'its entry' };
// The part's family for the words: cause_quote, quote, said are quotes; teach.rule is rule.
const family = p => (/quote$|^said$|\.said$|\.quote$/.test(p) ? 'quote' : p.split('.').pop());

/**
 * The run's summary (pure): {items, complete, missing, reasked, part, parts, failing}. parts counts each missing part
 * (fake quotes as 'quote'); part is the commonest; failing lists the items still failing (at most 20).
 */
export function summarise(rows, reasked = 0) {
  const parts = {};
  for (const r of rows) {
    for (const p of r.missing) { const f = family(p); parts[f] = (parts[f] || 0) + 1; }
    if (r.fake.length) parts.quote = (parts.quote || 0) + 1;
  }
  const failing = rows.filter(r => !r.ok);
  const part = Object.entries(parts).sort((a, b) => b[1] - a[1] || (b[0] === 'quote') - (a[0] === 'quote'))[0];
  return { items: rows.length, complete: rows.length - failing.length, missing: failing.length, reasked, part: part ? part[0] : null, parts,
    failing: failing.slice(0, FAILING_MAX).map(r => ({ id: r.id, missing: [...r.missing, ...r.fake.map(f => `${f} (not his words)`)] })) };
}

/** The counts a job line carries (job-log counts; recent.js words them with auditWords). */
export const auditCounts = s => (s ? { chk: s.items, chk_missing: s.missing, chk_reasked: s.reasked, chk_part: s.part || 'none' } : {});

export function auditWords(c) {
  if (!c || c.chk == null) return null;
  const n = Number(c.chk_missing) || 0, again = Number(c.chk_reasked) || 0;
  if (!n) return again ? `checked: all parts present (${again} asked again)` : 'checked: all parts present';
  const what = PART_WORD[c.chk_part] || 'a part';
  return `${n} ${n === 1 ? 'item' : 'items'} missing ${what}${again ? ' (asked again once)' : ''}`;
}

/**
 * The user text that asks again for the failing items (pure): which items, what each lacks, and that only those come
 * back, in the same schema. label: how an item is named to the model ("Q3", "card 4", "m2").
 */
export function reaskText(rows, label = id => id) {
  const lines = rows.filter(r => !r.ok).map(r => {
    const bits = [];
    if (r.missing.length) bits.push(`give ${r.missing.join(', ')}`);
    if (r.fake.length) bits.push(`${r.fake.join(', ')} must be his own words copied exactly from his words above (or empty if he said nothing usable)`);
    return `- ${label(r.id)}: ${bits.join('; ')}.`;
  });
  return `A check of your answer found these items incomplete. Answer again for ONLY these items, by the same rules and in the same JSON shape (the other items left out):\n${lines.join('\n')}`;
}

export async function auditAndReask(items, { idOf, check, reask = null }) {
  let list = items.slice();
  let rows = list.map(check);
  let reasked = 0;
  const bad = rows.filter(r => !r.ok);
  if (bad.length && reask) {
    reasked = bad.length;
    const again = await reask(bad);
    if (Array.isArray(again) && again.length) {
      const by = new Map(again.filter(x => x != null).map(x => [String(idOf(x)), x]));
      list = list.map((x, i) => {
        const y = by.get(String(idOf(x)));
        if (!y) return x;
        // Kept only when it asks no less of itself (a re-ask must not dodge a part by changing its verdict) and fails
        // on fewer parts than the first answer.
        const r = check(y), was = rows[i];
        const asStrict = was.required.every(p => r.required.includes(p));
        return asStrict && r.missing.length + r.fake.length < was.missing.length + was.fake.length ? y : x;
      });
      rows = list.map(check);
    }
  }
  list = list.map((x, i) => dropFake(x, rows[i]));
  return { items: list, rows, reasked };
}

/**
 * Store one run's record (ai_audits) and answer its summary. Never throws; before 0064 it only answers the summary.
 * key: the run's id within the job (a block id, a session id, a day).
 */
export async function recordAudit(env, { job, key, ref = null, rows, reasked = 0, at = Date.now(), user = 'mo' }) {
  const s = summarise(rows || [], reasked);
  noteTrace(t => t.noteAudit({ job, items: s.items, missing: s.missing }));   // the run's trace (debug/trace.js)
  try {
    if (env && env.DB) {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO ai_audits (user_id, id, job, ref, at, items, complete, reasked, missing, parts_json, failing_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT (user_id, id) DO UPDATE SET at = excluded.at, ref = excluded.ref, items = excluded.items, complete = excluded.complete, reasked = excluded.reasked,
            missing = excluded.missing, parts_json = excluded.parts_json, failing_json = excluded.failing_json`)
          .bind(user, `${job}:${key}`.slice(0, 200), job, ref == null ? null : String(ref).slice(0, 120), at, s.items, s.complete, s.reasked, s.missing,
            JSON.stringify(s.parts), JSON.stringify(s.failing)),
        env.DB.prepare('DELETE FROM ai_audits WHERE user_id = ? AND at < ?').bind(user, at - KEEP_MS),
      ]);
    }
  } catch (e) { if (!noTable(e)) console.error('ai audit not stored', job, e && e.message); }
  return s;
}

// ---------------------------------------------------------------- what each job must give

const FLAGGED_UW = ['wrong', 'right_flawed'];
const core = (x, flagged) => coreAudit(x, { flagged });
const merge = (a, b) => ({ required: [...a.required, ...b.required.filter(p => !a.required.includes(p))], quotes: [...a.quotes, ...b.quotes.filter(p => !a.quotes.includes(p))] });
export const AUDIT_SPECS = {
  uworld_judge: v => {
    const flagged = FLAGGED_UW.includes(v.verdict);
    const own = flagged ? { required: ['why', 'error_type', 'teach.rule', 'teach.condition', 'teach.say', ...(v.verdict === 'right_flawed' ? ['flaw_kind'] : [])], quotes: ['quote'] }
      : v.verdict === 'sound' ? { required: ['why'], quotes: ['quote'] } : { required: [], quotes: ['quote'] };
    return merge(own, core(v, flagged));
  },
  nbme_judge: r => {
    const flagged = FLAGGED_UW.includes(r.verdict);
    return merge(flagged ? { required: ['error_type', 'rule', 'topic', 'gap'], quotes: ['mo_quote'] } : { required: [], quotes: ['mo_quote'] }, core(r, flagged));
  },
  nbme_checker: c => { const a = core({ cause_inferred: c.cause_inferred, cause: c.cause }, FLAGGED_UW.includes(c.verdict)); return { required: a.required, quotes: ['cause_quote'] }; },
  uworld_review_talk: x => (x.kind === 'question' ? merge(merge({ required: [], quotes: ['said'] }, core(x, false)), { required: x.cause && (x.cause_inferred === 0 || x.cause_inferred === false) ? ['cause_quote'] : [], quotes: [] })
    : x.kind === 'gap' ? { required: ['topic', 'gap'], quotes: ['said'] } : { required: ['quote'], quotes: ['quote'] }),
  anki_check: c => { const flagged = c.verdict === 'gap' || c.verdict === 'shaky'; return merge(flagged ? { required: ['gap'], quotes: ['said'] } : { required: [], quotes: ['said'] }, core(c, flagged)); },
  viva: p => (p.kind === 'core' ? core(p, !!p.flagged)
    : { required: p.kind === 'point' ? ['status', ...(p.status === 'said' || p.status === 'wrong' ? ['quote'] : [])] : [], quotes: ['quote'] }),
  rejudge: x => ({ required: ['cause'], quotes: ['cause_quote'] }),
  // The pattern review (map/patterns.js): an entry for every item sent.
  patterns: () => ({ required: ['entry'], quotes: [] }),
  cluster_name: () => ({ required: ['name'], quotes: [] }),
};
