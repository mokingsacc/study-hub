import * as subjects from './subjects.js';
import * as results from './results.js';
import * as library from './library.js';
import * as cards from './cards.js';
import * as me from './me.js';
import * as papers from './papers.js';
import * as sharing from './sharing.js';
import * as teach from './teach.js';
import * as map from './map.js';
import * as custom from './custom.js';
import * as exams from './exams.js';
import * as galaxies from './galaxies.js';
import * as guide from './guide.js';
import * as recent from './recent.js';
import * as pictures from './pictures.js';
import * as ink from './ink.js';
import * as mnemonics from './mnemonics.js';
import * as chats from './chats.js';
import * as activity from './activity.js';
import * as move from './move.js';
import * as viva from './viva.js';
import * as correct from './correct.js';
import * as nowSteps from './now.js';

const MODULES = [subjects, results, library, cards, me, papers, sharing, teach, map, custom, exams, galaxies, guide, recent, pictures, ink, mnemonics, chats, activity, move, viva, correct, nowSteps];

export function routes() {
  return MODULES.flatMap(m => m.ROUTES || []);
}

export async function onAccountCreated(env, user, body) {
  for (const m of MODULES) if (typeof m.onAccountCreated === 'function') await m.onAccountCreated(env, user, body);
}

// Connector tools from every module: [{name, description, inputSchema, annotations?, run(env, user, args, ctx)}].
export function tools() {
  return MODULES.flatMap(m => m.TOOLS || []);
}

// Self-check items from every module: [async (env, user) => [{id, ok, level, says, fix?}]] (selfcheck.js).
export function checks() {
  return MODULES.flatMap(m => m.CHECKS || []);
}
