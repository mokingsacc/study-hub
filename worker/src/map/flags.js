// The topic marks in SQL (plan §9 Topic flags; owner LOOK). One expression, shared by the map payload
// (payload.js) and panel's topicDetail, so the mini card and the panel can never disagree about a mark.
// The bits and their words live in public/js/map/marks.js, which the page reads too.
//
//   topicFlagsSql({user, today, now, dayStart, t, s})   the expression, with your own placeholders
//   TOPIC_FLAGS_SQL                                      the same with ?1 user, ?2 today, ?3 now, ?4 dayStart
//   flagParams(user, now)                                [user, today, now, dayStart] for those four binds
//
// The expression reads the topics row as `t` and its LEFT JOINed topic_scores row as `s` (rename them with the
// options). Every subquery is scoped by user_id and uses an index from 0010 (lessons_topic, lessons_status,
// ix_misses_topic, ix_ev_topic, idx_unit_topics_topic). Held rows and deleted misses never count, so an
// unfinished sitting shows no marks.
import { TOPIC_FLAGS as F } from '../../../public/js/map/marks.js';
import { londonDay, londonDayStart } from '../util.js';
import { EVIDENCE, DAY_MS } from '../../../public/js/shared/evidence.js';

export { TOPIC_FLAGS } from '../../../public/js/map/marks.js';

export const REQUEST_MS = 72 * 3600_000;    // a Teach me tap is listed for 72 h (plan §2.2 tier 2)
export const TEACHING_MS = 3 * 3600_000;    // a lesson still in progress after 3 h is stale (teach's clean-up)

const IDENT = /^[a-z_][a-z0-9_]*$/;
const PARAM = /^(\?\d{1,2}|:[a-z_]+)$/;
function check(v, re, what) {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`topicFlagsSql: bad ${what} ${String(v).slice(0, 20)}`);
  return v;
}

export function topicFlagsSql({ user = '?1', today = '?2', now = '?3', dayStart = '?4', t = 't', s = 's' } = {}) {
  // today is still checked (the callers bind it), though no flag reads it since the re-test dot went (1 Nov 2026).
  const [u, , n, ds] = [check(user, PARAM, 'user'), check(today, PARAM, 'today'), check(now, PARAM, 'now'), check(dayStart, PARAM, 'dayStart')];
  const [T, S] = [check(t, IDENT, 'alias'), check(s, IDENT, 'alias')];
  const lesson = cond => `EXISTS (SELECT 1 FROM lessons l WHERE l.user_id = ${u} AND (l.topic_id = ${T}.id OR l.pair_topic_id = ${T}.id) AND ${cond})`;
  // A pair test is not a lesson (LRN4-1): it never makes a topic "taught today" or answers a stated gap.
  const lastLesson = `coalesce((SELECT max(l.ended_at) FROM lessons l WHERE l.user_id = ${u} AND (l.topic_id = ${T}.id OR l.pair_topic_id = ${T}.id)
      AND l.status = 'done' AND coalesce(l.kind, 'lesson') <> 'pair_test'), 0)`;
  // n_eff now (shared/evidence.js nEff, levelOfScore): the stored question-side weight faded from its review clock; a row
  // from before 0055 counts its questions and re-tests from the last one.
  const fade = `${EVIDENCE.fade_days * DAY_MS}.0`;
  const neff = `(CASE WHEN ${S}.fsrs_real_n IS NOT NULL THEN ${S}.fsrs_real_n * pow(0.5, max(0, ${n} - coalesce(${S}.fsrs_at, ${S}.last_question_at, ${n})) / ${fade})
      ELSE (coalesce(${S}.questions_n, 0) + coalesce(${S}.retests_n, 0)) * pow(0.5, max(0, ${n} - coalesce(${S}.last_question_at, ${n})) / ${fade}) END)`;
  return `(
    (CASE WHEN ${T}.status = 'proposed' THEN ${F.proposed} ELSE 0 END)
  | (CASE WHEN coalesce(${S}.seen, 0) = 1 AND ${neff} < ${EVIDENCE.thin} THEN ${F.thin} ELSE 0 END)
  | (CASE WHEN coalesce(${S}.seen, 0) = 1 AND ${neff} >= ${EVIDENCE.solid} AND coalesce(${S}.last_question_at, 0) >= ${n} - ${EVIDENCE.recent_days * DAY_MS}
      THEN ${F.solid} ELSE 0 END)
  | (CASE WHEN ${lesson(`l.status = 'done' AND l.ended_at >= ${ds} AND coalesce(l.kind, 'lesson') <> 'pair_test'`)} THEN ${F.taught_today} ELSE 0 END)
  | (CASE WHEN ${lesson(`l.status = 'requested' AND coalesce(l.requested_at, 0) >= ${n} - ${REQUEST_MS}`)} THEN ${F.requested} ELSE 0 END)
  | (CASE WHEN ${lesson(`l.status = 'in_progress' AND coalesce(l.started_at, 0) >= ${n} - ${TEACHING_MS}`)} THEN ${F.teaching_now} ELSE 0 END)
  | (CASE WHEN coalesce(${S}.sure_wrong_n, 0) > 0 THEN ${F.sure_wrong} ELSE 0 END)
  | (CASE WHEN coalesce(${S}.slow_n, 0) > 0 THEN ${F.slow} ELSE 0 END)
  | (CASE WHEN EXISTS (SELECT 1 FROM units u WHERE u.user_id = ${u} AND u.id = ${T}.unit_id AND u.kind = 'checklist')
      OR ${T}.id IN (SELECT ut.topic_id FROM unit_topics ut JOIN units u ON u.user_id = ut.user_id AND u.id = ut.unit_id
        WHERE ut.user_id = ${u} AND u.kind = 'checklist') THEN ${F.checklist} ELSE 0 END)
  | (CASE WHEN EXISTS (SELECT 1 FROM evidence e WHERE e.user_id = ${u} AND e.topic_id = ${T}.id AND e.held = 0 AND e.kind = 'gap_stated'
      AND e.at > ${lastLesson}) THEN ${F.gap} ELSE 0 END)
  )`;
}

export const TOPIC_FLAGS_SQL = topicFlagsSql();

/** The four binds TOPIC_FLAGS_SQL expects after the user: [user, today, now, dayStart] (London day). */
export function flagParams(user, now = Date.now()) {
  return [user, londonDay(now), now, londonDayStart(now)];
}
