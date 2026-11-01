import * as photos from '../photos.js';
import * as pictures from '../pictures.js';
import * as inbox from '../photo-inbox.js';

const moOnly = (a, p, c) => (c && c.actor === 'claude' ? 'refused' : 'free');
// topic_photos is not in guard.js WRITABLE: only these two ops write it (insert, soft delete).
const WRITES = { topic_photos: { actions: 'id', cols: ['topic_id', 'r2_key', 'mime', 'width', 'height', 'bytes', 'source', 'created_at', 'deleted_at'] },
  topic_pictures: { actions: 'd', cols: ['hidden_at'] } };
const INBOX_COLS = ['r2_key', 'thumb_key', 'mime', 'width', 'height', 'bytes', 'source', 'created_at', 'filed_at', 'topic_id', 'photo_id', 'deleted_at'];
const INBOX_WRITES = { photo_inbox: { actions: 'id', cols: INBOX_COLS } };
const FILE_WRITES = { topic_photos: { actions: 'i', cols: WRITES.topic_photos.cols }, photo_inbox: { actions: 'u', cols: ['filed_at', 'topic_id', 'photo_id'] } };
const AUTO_WRITES = { topic_pictures: { actions: 'i', cols: ['title', 'matched_by', 'created_at', 'hidden_at'] } };

export const CHANGE_KINDS = {
  'topic_photo.add': { tier: moOnly, reason: 'Photos are added on the topic panel.', kind: 'media.added', undoable: true, page_only: true, writes: WRITES,
    plan: (...a) => photos.planPhotoAdd(...a) },
  'topic_photo.reorder': { tier: moOnly, reason: 'Photos are moved on the topic panel.', kind: 'media.reordered', undoable: true, page_only: true,
    writes: { topic_photos: { actions: 'u', cols: ['sort'] } }, plan: (...a) => photos.planPhotoReorder(...a) },
  'topic_photo.remove': { tier: moOnly, reason: 'Photos are removed on the topic panel.', kind: 'media.removed', undoable: true, page_only: true, writes: WRITES,
    plan: (...a) => photos.planPhotoRemove(...a) },
  'photo_inbox.add': { tier: moOnly, reason: 'Photos are added to the inbox on the hub page.', kind: 'media.added', undoable: true, page_only: true, writes: INBOX_WRITES,
    plan: (...a) => inbox.planInboxAdd(...a) },
  'photo_inbox.file': { tier: 'free', kind: 'media.added', undoable: true, writes: FILE_WRITES, plan: (...a) => inbox.planInboxFile(...a) },
  'photo_inbox.discard': { tier: 'free', kind: 'media.removed', undoable: true, writes: INBOX_WRITES, plan: (...a) => inbox.planInboxDiscard(...a) },
  'topic_picture.hide': { tier: moOnly, reason: 'Pictures are hidden on the topic panel.', kind: 'media.removed', undoable: true, page_only: true, writes: WRITES,
    plan: (...a) => pictures.planPictureHide(...a) },
  'topic_picture.auto': { tier: (a, p, c) => (c && c.actor === 'code' ? 'free' : 'refused'), reason: 'Pictures are found automatically by the hub.', kind: 'media.found', page_only: true,
    undoable: true, writes: AUTO_WRITES, plan: (...a) => pictures.planPictureAuto(...a) },
};

export const ROUTES = [
  ['POST', '/api/map/topic/:id/photos', (...a) => photos.addRoute(...a)],
  ['POST', '/api/map/topic/:id/photos/order', (...a) => photos.orderRoute(...a)],
  ['DELETE', '/api/map/topic/:id/photos/:photo_id', (...a) => photos.removeRoute(...a)],
  ['GET', '/api/map/photos/:id', (...a) => photos.photoRoute(...a)],
  ['GET', '/api/map/photo-inbox', (...a) => inbox.listRoute(...a)],
  ['POST', '/api/map/photo-inbox', (...a) => inbox.addRoute(...a)],
  ['GET', '/api/map/photo-inbox/:id', (...a) => inbox.imageRoute(...a)],
  ['DELETE', '/api/map/photo-inbox/:id', (...a) => inbox.discardRoute(...a)],
  ['POST', '/api/map/seed/pictures', (...a) => pictures.seedRoute(...a)],
  ['DELETE', '/api/map/topic/:id/pictures/:ref', (...a) => pictures.hideRoute(...a)],
  ['GET', '/api/map/pictures/:ref', (...a) => pictures.pictureRoute(...a)],
];

const T = 't', I = 'i';
// The rows are exported; the bytes stay in R2 under each row's r2_key.
export const EXPORT = {
  topic_photos: {
    cols: ['user_id', 'id', 'topic_id', 'r2_key', 'mime', 'width', 'height', 'bytes', 'source', 'created_at', 'deleted_at', 'sort'],
    required: ['user_id', 'id', 'topic_id', 'r2_key', 'mime', 'created_at'],
    types: { user_id: T, id: T, topic_id: T, r2_key: T, mime: ['image/jpeg', 'image/webp', 'image/png'], width: I, height: I, bytes: I,
      source: ['paste', 'drop', 'file', 'camera'], created_at: I, deleted_at: I, sort: I },
  },
  photo_inbox: {
    cols: ['user_id', 'id', 'r2_key', 'thumb_key', 'mime', 'width', 'height', 'bytes', 'source', 'created_at', 'filed_at', 'topic_id', 'photo_id', 'deleted_at'],
    required: ['user_id', 'id', 'r2_key', 'mime', 'created_at'],
    types: { user_id: T, id: T, r2_key: T, thumb_key: T, mime: ['image/jpeg', 'image/webp', 'image/png'], width: I, height: I, bytes: I,
      source: ['paste', 'drop', 'file', 'camera'], created_at: I, filed_at: I, topic_id: T, photo_id: T, deleted_at: I },
  },
};
export const EXPORT_SKIP = { topic_pictures: 'Library pictures matched to topics: remade by POST /api/map/seed/pictures and the picture job (a hide is kept in the live table).',
  topic_picture_checks: 'Which topics the picture job has looked at (auto-pictures.js): bookkeeping; without it the job simply looks again.' };
