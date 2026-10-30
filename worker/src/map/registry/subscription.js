// Subscription (guard, changes, prefs) registry (owner: SUB). The shapes are at the top of registry/index.js.
// Planners are wrapped so this file only touches them at call time (registry import cycles stay harmless).
import { planSetting, settingTier } from '../../settings.js';
import { planPref } from '../prefs.js';
import { planUndo, undoTier, applyUndo, undoRoute } from '../change.js';

export const CHANGE_KINDS = {
  // Public hub settings (validateSettings); raising a spend cap, check_mode and exam_date are confirmed.
  'setting.set': { tier: (a, p, c) => settingTier(a, p, c), kind: 'setting.changed', undoable: true, plan: (...a) => planSetting(...a) },
  // How a page looks: ui_prefs paths registered by each page's owner.
  'pref.set': { tier: 'free', kind: 'pref.changed', undoable: true, plan: (...a) => planPref(...a) },
  // Claude's own last five changes from the last day are free; anything else is confirmed. Undoing an undo redoes it.
  undo: { tier: (a, p, c) => undoTier(a, p, c), kind: 'undo', undoable: true, plan: (...a) => planUndo(...a), apply: (...a) => applyUndo(...a) },
};

export const ROUTES = [
  ['POST', '/api/changes/undo', (...a) => undoRoute(...a)],
];

// Page settings are registered by each page's owner; this area has none of its own (tests add theirs here).
export const PREFS = {};
