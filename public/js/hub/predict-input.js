
const FORM_NAME = /\b(nbme|uwsa|cms)\b|self[- ]?assess/i;
const FROM_EXAM_TYPE = { nbme: 'nbme', uwsa: 'uwsa', free120: 'free120', uworld_avg: 'uworld_qbank', hub: 'hub_practice', other: 'other' };

export function examKind(text, hubKind) {
  const t = String(text || '').toLowerCase();
  if (/\buwsa\b|self[- ]?assess/.test(t)) return 'uwsa';
  if (/free\s*-?\s*120/.test(t)) return 'free120';
  if (/\bnbme\b|\bcms\b/.test(t)) return 'nbme';
  if (/\buworld\b|\bqbank\b|question bank/.test(t)) return 'uworld_qbank';
  return hubKind === 'hub' ? 'hub_practice' : 'other';
}

/** The sitting form's choice when there is one; for older rows, the guess from the name. */
export const guessExamType = (text, hubKind) => ({ uworld_qbank: 'uworld_avg', hub_practice: 'hub' }[examKind(text, hubKind)] || examKind(text, hubKind));

export function predictorInput(results, sittings = []) {
  const byId = new Map(sittings.map(s => [s.id, s]));
  return (results || []).map(r => {
    const s = byId.get(r.sitting_id) || {};
    const parts = [r.name, r.external_label ?? s.external_label].filter(Boolean);
    const named = parts.filter(p => FORM_NAME.test(p));
    const label = [...named, ...parts.filter(p => !named.includes(p))].join(' · ');
    const type = r.exam_type ?? s.exam_type;
    const kind = FROM_EXAM_TYPE[type] || examKind(label, r.kind);
    return { ...r, label, hub_kind: r.kind, kind, questions: r.questions ?? r.scored ?? undefined };
  });
}
