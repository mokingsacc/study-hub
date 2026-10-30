import * as photos from '../photos.js';
import * as pictures from '../pictures.js';

const moOnly = (a, p, c) => (c && c.actor === 'claude' ? 'refused' : 'free');
// topic_photos is not in guard.js WRITABLE: only these two ops write it (insert, soft delete).
const WRITES = { topic_photos: { actions: 'id', cols: ['topic_id', 'r2_key', 'mime', 'width', 'height', 'bytes', 'source', 'created_at', 'deleted_at'] },
  topic_pictures: { actions: 'd', cols: ['hidden_at'] } };

export const CHANGE_KINDS = {
  'topic_photo.add': { tier: moOnly, reason: 'Photos are added on the topic panel.', kind: 'media.added', undoable: true, page_only: true, writes: WRITES,
    plan: (...a) => photos.planPhotoAdd(...a) },
  'topic_photo.remove': { tier: moOnly, reason: 'Photos are removed on the topic panel.', kind: 'media.removed', undoable: true, page_only: true, writes: WRITES,
    plan: (...a) => photos.planPhotoRemove(...a) },
  'topic_picture.hide': { tier: moOnly, reason: 'Pictures are hidden on the topic panel.', kind: 'media.removed', undoable: true, page_only: true, writes: WRITES,
    plan: (...a) => pictures.planPictureHide(...a) },
};

export const ROUTES = [
  ['POST', '/api/map/topic/:id/photos', (...a) => photos.addRoute(...a)],
  ['DELETE', '/api/map/topic/:id/photos/:photo_id', (...a) => photos.removeRoute(...a)],
  ['GET', '/api/map/photos/:id', (...a) => photos.photoRoute(...a)],
  ['POST', '/api/map/seed/pictures', (...a) => pictures.seedRoute(...a)],
  ['DELETE', '/api/map/topic/:id/pictures/:ref', (...a) => pictures.hideRoute(...a)],
  ['GET', '/api/map/pictures/:ref', (...a) => pictures.pictureRoute(...a)],
];

const T = 't', I = 'i';
// The rows are exported; the bytes stay in R2 under each row's r2_key.
export const EXPORT = {
  topic_photos: {
    cols: ['user_id', 'id', 'topic_id', 'r2_key', 'mime', 'width', 'height', 'bytes', 'source', 'created_at', 'deleted_at'],
    required: ['user_id', 'id', 'topic_id', 'r2_key', 'mime', 'created_at'],
    types: { user_id: T, id: T, topic_id: T, r2_key: T, mime: ['image/jpeg', 'image/webp', 'image/png'], width: I, height: I, bytes: I,
      source: ['paste', 'drop', 'file', 'camera'], created_at: I, deleted_at: I },
  },
};
export const EXPORT_SKIP = { topic_pictures: 'AnKing pictures matched to topics: remade by POST /api/map/seed/pictures (a hide is kept in the live table).' };
