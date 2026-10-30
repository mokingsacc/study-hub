// Feature switches per person (docs/platform/plan.md §5). A module is on when its flag allows it, the person's
// track offers it, and their saved choice (users.prefs_json.modules.<id>) or else the track default says on.
// The session already carries prefs_json and the profile, so requireModule costs no query.
import { HttpError } from '../util.js';
import { buildProfile } from '../profiles.js';
import { safeParse } from '../util.js';

export const LEARNER = 'mo';

export const MODULES = {
  map: { label: 'Subjects and topics', always: true },
  results: { label: 'Log results from question banks and past papers' },
  cards: { label: 'Flashcards' },
  library: { label: 'Library: your papers, mark schemes and notes' },
  connector: { label: 'Use your own Claude with the hub' },
  gaps: { label: '"Gap:" notes' },
  ai_topics: { label: 'AI suggests topics for each subject' },
  countdown: { label: 'Days to your exams' },
  papers: { label: 'Write practice papers in the app (needs your own Claude key)' },
  exams: { label: 'Exams and practice papers: past papers on screen, practice papers your Claude writes' },
  mnemonics: { label: 'Mnemonics: memory hooks with their own letter-by-letter test' },
  anki_link: { label: 'Link your own Anki', flag: 'ANKI_LINK' },
};

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** {id: boolean} for every module, from the profile (object or name), the saved prefs and the env flags. */
export function modulesFor(profile, prefs = {}, env = {}) {
  const p = typeof profile === 'string' ? buildProfile(profile) : profile || buildProfile(null);
  const def = (p && p.modules) || { on: Object.keys(MODULES), off: [] };
  const saved = isObj(prefs) && isObj(prefs.modules) ? prefs.modules : {};
  const out = {};
  for (const [id, m] of Object.entries(MODULES)) {
    if (m.always) { out[id] = true; continue; }
    const offered = (def.on || []).includes(id) || (def.off || []).includes(id);
    const flagOk = !m.flag || (env && env[m.flag] === '1');
    const built = m.built !== false;
    const want = typeof saved[id] === 'boolean' ? saved[id] : (def.on || []).includes(id);
    out[id] = !!(offered && flagOk && built && want);
  }
  return out;
}

// What Settings shows: each module with whether it can be switched.
export function moduleList(profile, prefs, env) {
  const p = typeof profile === 'string' ? buildProfile(profile) : profile;
  const def = (p && p.modules) || { on: [], off: [] };
  const on = modulesFor(p, prefs, env);
  return Object.entries(MODULES).map(([id, m]) => ({
    id, label: m.label, on: on[id],
    can_switch: !m.always && m.built !== false && (!m.flag || (env && env[m.flag] === '1')) && ((def.on || []).includes(id) || (def.off || []).includes(id)),
  }));
}

// The session's modules (resolveSession adds prefs_json and profile). Cached on the session object.
export function sessionModules(session, env) {
  if (!session) return {};
  if (!session._modules) session._modules = modulesFor(session.profile, typeof session.prefs_json === 'string' ? safeParse(session.prefs_json, {}) : session.prefs_json || {}, env);
  return session._modules;
}

// Feature handlers start with this: 404 in plain words when the person switched the part off.
export function requireModule(session, id, env) {
  const mods = sessionModules(session, env);
  if (![].concat(id).some(x => mods[x])) throw new HttpError(404, 'This part is switched off. You can turn it on in Settings.');
}

/** A statement setting one module on or off, for writeBatch (validated here; users.js prefsStatement writes it). */
export function moduleChange(profile, id, on, env) {
  const m = MODULES[id];
  if (!m) throw new HttpError(400, 'There is no such part to switch.');
  const row = moduleList(profile, {}, env).find(x => x.id === id);
  if (!row || !row.can_switch) throw new HttpError(400, `${m.label} cannot be switched here.`);
  if (typeof on !== 'boolean') throw new HttpError(400, 'Say on or off.');
  return { path: `modules.${id}`, value: on };
}
