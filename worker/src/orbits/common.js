// Map orbits (I33): shared bits for the Worker side. Every route checks its flag first; while it is off the route
// answers 404 {error: 'Not found.'} as if it did not exist (MAP_ORBITS for orbits, atlas and links; DUE_ORBS for the
// due counts and the subject review).
import { HttpError } from '../util.js';
import { norm } from '../../../public/js/shared/names.js';

export const orbitsOn = env => !!env && env.MAP_ORBITS === 'on';
export const dueOn = env => !!env && env.DUE_ORBS === 'on';
export function needOrbits(env) { if (!orbitsOn(env)) throw new HttpError(404, 'Not found.'); }
export function needDue(env) { if (!dueOn(env)) throw new HttpError(404, 'Not found.'); }

export const RELS = ['treats', 'adverse_effect', 'avoid_in', 'causes'];
export const HOWS = ['first_line', 'alternative', 'prophylaxis', 'antidote', 'adjunct', 'common', 'serious', 'teratogen', 'classic', 'complication'];

export { norm };

async function sha12(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}
/** 'ol_' + 12 hex of sha256(user|item|rel|norm(to_name)): a re-seed lands on the same row. */
export const linkId = async (user, itemId, rel, toName) => `ol_${await sha12(`${user}|${itemId}|${rel}|${norm(toName)}`)}`;

/** No arrows, no angle brackets, at most 200 characters (DESIGN §9). */
export const WHY_BAD = /[<>→←↔⇒⇐]|->|<-/;
export const parseJson = (t, fb) => { try { const v = JSON.parse(t); return v ?? fb; } catch { return fb; } };
