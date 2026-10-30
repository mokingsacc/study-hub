export const UWORLD_SYSTEMS = [
  'Allergy & Immunology', 'Biostatistics & Epidemiology', 'Cardiovascular System', 'Dermatology', 'Ear, Nose & Throat (ENT)',
  'Endocrine, Diabetes & Metabolism', 'Female Reproductive System & Breast', 'Gastrointestinal & Nutrition', 'General Principles',
  'Hematology & Oncology', 'Infectious Diseases', 'Male Reproductive System', 'Miscellaneous (Multisystem)', 'Nervous System',
  'Ophthalmology', 'Poisoning & Environmental Exposure', 'Pregnancy, Childbirth & Puerperium',
  'Psychiatric/Behavioral & Substance Use Disorder', 'Pulmonary & Critical Care', 'Renal, Urinary Systems & Electrolytes',
  'Rheumatology/Orthopedics & Sports', 'Social Sciences (Ethics/Legal/Professional)',
];
const ALIASES = { psychiatry: 'Psychiatric/Behavioral & Substance Use Disorder', ent: 'Ear, Nose & Throat (ENT)', ethics: 'Social Sciences (Ethics/Legal/Professional)',
  musculoskeletal: 'Rheumatology/Orthopedics & Sports', obstetrics: 'Pregnancy, Childbirth & Puerperium', gynecology: 'Female Reproductive System & Breast',
  neurology: 'Nervous System', cardiology: 'Cardiovascular System', gastroenterology: 'Gastrointestinal & Nutrition', nephrology: 'Renal, Urinary Systems & Electrolytes' };

const keyOf = s => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
const KEYS = UWORLD_SYSTEMS.map(name => [keyOf(name), name]);

export function normSystem(v) {
  if (typeof v !== 'string') return v == null ? null : v;
  const raw = v.replace(/\s*(?:\.{2,}|…)\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const k = keyOf(raw);
  if (!k) return raw;
  const exact = KEYS.find(([key]) => key === k);
  if (exact) return exact[1];
  if (ALIASES[k]) return ALIASES[k];
  if (k.length >= 4) {
    const hits = KEYS.filter(([key]) => key.startsWith(k));
    if (hits.length === 1) return hits[0][1];
  }
  return raw;
}

// ---------------------------------------------------------------- the one-off back-fill of stored labels
export const TIDY_KEY = 'systems_tidied_v1';

export async function tidySystems(env) {
  if (!env || !env.DB) return null;
  const { all, getSetting, setSetting } = await import('./db.js'); // loaded here: map-fields.js reads this file and has no D1
  if (await getSetting(env, TIDY_KEY)) return null;
  const stmts = [];
  let blocks = 0;
  for (const b of await all(env, 'SELECT id, questions_json FROM uworld_blocks')) {
    let qs;
    try { qs = JSON.parse(b.questions_json || '[]'); } catch { continue; }
    if (!Array.isArray(qs)) continue;
    let changed = false;
    const next = qs.map(q => {
      if (!q || typeof q.system !== 'string') return q;
      const s = normSystem(q.system);
      if (s === q.system) return q;
      changed = true;
      return { ...q, system: s };
    });
    if (changed) { stmts.push(env.DB.prepare('UPDATE uworld_blocks SET questions_json = ? WHERE id = ? AND questions_json IS ?').bind(JSON.stringify(next), b.id, b.questions_json)); blocks++; }
  }
  const labels = (await all(env, 'SELECT DISTINCT system_raw FROM misses WHERE system_raw IS NOT NULL')).map(r => [r.system_raw, normSystem(r.system_raw)]).filter(([a, b]) => b && a !== b);
  for (const [from, to] of labels) stmts.push(env.DB.prepare('UPDATE misses SET system_raw = ? WHERE system_raw = ?').bind(to, from));
  if (stmts.length) await env.DB.batch(stmts); // one round trip, however many labels
  const out = { at: Date.now(), blocks, misses_labels: labels.length };
  await setSetting(env, TIDY_KEY, out);
  return out;
}
