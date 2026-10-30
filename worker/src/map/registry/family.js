// People and profiles registry (owner: INT). users is exported and imported like every map table; the v3
// secret tables (passkeys, sessions, invites) will go in EXPORT_SKIP when they exist.
import { ROLES, STATUSES } from '../../profiles.js';

export const EXPORT = {
  users: {
    cols: ['id', 'name', 'role', 'profile', 'profile_json', 'prefs_json', 'status', 'created_at', 'updated_at'],
    required: ['id', 'name', 'role', 'profile', 'created_at', 'updated_at'],
    types: { id: 't', name: 't', role: ROLES, profile: 't', profile_json: 'jo', prefs_json: 'jo', status: STATUSES, created_at: 'i', updated_at: 'i' },
  },
};
