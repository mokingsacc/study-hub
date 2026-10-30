import { HttpError, json, readJson } from './util.js';
import { all, run } from './db.js';
import { echoShare, ECHO_SHARE, ECHO_MIN_RUNS, checkSource } from './spoken.js';
import { saveCues, scrubStems } from './gaps.js';
import { noteJob } from './job-log.js';

const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const soft = e => { if (!/no such (?:table|column)/i.test(String(e && e.message))) throw e; };

export async function echoSessions(env) {
  const sessions = await all(env, 'SELECT id, day, segments_json FROM anki_sessions');
  const blocks = await all(env, 'SELECT id, day, segments_json FROM uworld_blocks');
  const out = [];
  for (const s of sessions) {
    const segs = parse(s.segments_json, []);
    for (const b of blocks) {
      const gapDays = Math.abs(Date.parse(s.day) - Date.parse(b.day)) / 86_400_000;
      if (!(gapDays <= 1)) continue;
      const o = echoShare(segs, parse(b.segments_json, []));
      if (o.shared >= ECHO_MIN_RUNS && o.share > ECHO_SHARE) { out.push({ id: s.id, block: b.id, share: Math.round(o.share * 100) / 100 }); break; }
    }
  }
  return out;
}

export async function cleanup(env, { apply = false } = {}) {
  const report = {};
  // 1. Echo sessions.
  const echoes = await echoSessions(env);
  report.echo_sessions = echoes;
  if (apply) for (const e of echoes) {
    await saveCues(env, [], `anki:${e.id}`, () => ({}));   // removes its cue gaps and their map evidence
    await env.DB.batch([env.DB.prepare('DELETE FROM anki_cards WHERE session_id = ?').bind(e.id), env.DB.prepare('DELETE FROM anki_sessions WHERE id = ?').bind(e.id)]);
  }
  // 2. Cues on a card, mapped again (the minute sweep places them on the card's day).
  const cues = await all(env, `SELECT id FROM gaps WHERE source = 'spoken_cue' AND card_id IS NOT NULL AND ref LIKE 'anki:%' AND map_state IS NOT NULL`).catch(e => { soft(e); return []; });
  report.cues_remapped = cues.length;
  if (apply && cues.length) await run(env, `UPDATE gaps SET map_state = NULL WHERE source = 'spoken_cue' AND card_id IS NOT NULL AND ref LIKE 'anki:%'`);
  // 3. Device labels on Anki-check gaps (mapped again too, so the evidence carries the new source).
  const checks = await all(env, `SELECT g.id, s.device FROM gaps g JOIN anki_sessions s ON g.ref = 'anki:' || s.id
    WHERE g.source = 'anki_mac' AND s.device IN ('hub', 'phone')`);
  report.gaps_relabelled = checks.length;
  if (apply) for (const c of checks) await run(env, 'UPDATE gaps SET source = ?, map_state = NULL WHERE id = ?', checkSource(c.device), c.id);
  // 4. Stems read aloud, scrubbed from what is stored.
  let blocksScrubbed = 0, sessionsScrubbed = 0, cardsScrubbed = 0;
  for (const b of await all(env, 'SELECT id, segments_json FROM uworld_blocks')) {
    const segs = parse(b.segments_json, []), clean = scrubStems(segs);
    if (!changed(segs, clean)) continue;
    blocksScrubbed++;
    if (apply) await run(env, 'UPDATE uworld_blocks SET segments_json = ? WHERE id = ?', JSON.stringify(clean), b.id);   // updated_at kept: no re-judge from this
  }
  for (const s of await all(env, 'SELECT id, segments_json FROM anki_sessions')) {
    const segs = parse(s.segments_json, []), clean = scrubStems(segs);
    if (!changed(segs, clean)) continue;
    sessionsScrubbed++;
    if (apply) await run(env, 'UPDATE anki_sessions SET segments_json = ? WHERE id = ?', JSON.stringify(clean), s.id);
  }
  for (const c of await all(env, 'SELECT session_id, n, before_json, after_json FROM anki_cards WHERE words > 0')) {
    const side = j => { const list = parse(j, []); const clean = scrubStems(list); return { list, clean }; };
    const b = side(c.before_json), a = side(c.after_json);
    if (!changed(b.list, b.clean) && !changed(a.list, a.clean)) continue;
    cardsScrubbed++;
    if (apply) await run(env, 'UPDATE anki_cards SET before_json = ?, after_json = ? WHERE session_id = ? AND n = ?', JSON.stringify(b.clean), JSON.stringify(a.clean), c.session_id, c.n);
  }
  Object.assign(report, { blocks_scrubbed: blocksScrubbed, sessions_scrubbed: sessionsScrubbed, cards_scrubbed: cardsScrubbed });
  const old = await all(env, 'SELECT count(*) AS n, count(DISTINCT block_id) AS blocks FROM uworld_reviews WHERE words IS NULL').catch(e => { soft(e); return [{ n: 0, blocks: 0 }]; });
  report.uworld_questions_to_rejudge = (old[0] && old[0].n) || 0;
  report.uworld_blocks_to_rejudge = (old[0] && old[0].blocks) || 0;
  if (apply && report.uworld_questions_to_rejudge) await run(env, 'UPDATE uworld_reviews SET words = 0 WHERE words IS NULL');
  if (apply) await noteJob(env, { job: 'catchup_audit', key: String(Date.now()), counts: { echoes: echoes.length, cues: report.cues_remapped, relabelled: report.gaps_relabelled,
    scrubbed: blocksScrubbed + sessionsScrubbed + cardsScrubbed, rejudge: report.uworld_questions_to_rejudge } });
  return { applied: !!apply, ...report };
}

// POST /api/backfill/audit-cleanup {apply?}: the dry run by default.
export async function route(request, env) {
  const body = await readJson(request, 2_000).catch(() => ({}));
  if (body && body.apply != null && typeof body.apply !== 'boolean') throw new HttpError(400, 'apply must be true or false.');
  try {
    return json(await cleanup(env, { apply: !!(body && body.apply) }));
  } catch (e) {
    if (body && body.apply) await noteJob(env, { job: 'catchup_audit', key: `failed:${Date.now()}`, state: 'failed', detail: e });
    throw e;
  }
}
