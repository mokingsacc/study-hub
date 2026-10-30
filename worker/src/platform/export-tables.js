const T = 't', I = 'i', R = 'r';

export const PLATFORM_EXPORT = {
  galaxies: {
    cols: ['user_id', 'id', 'title', 'sort', 'status', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'title', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, title: T, sort: I, status: ['active', 'deleted'], created_by: T, created_at: I, updated_at: I },
  },
  galaxy_topics: {
    cols: ['user_id', 'topic_id', 'galaxy_id', 'created_by', 'created_at'],
    required: ['user_id', 'topic_id', 'galaxy_id', 'created_at'],
    types: { user_id: T, topic_id: T, galaxy_id: T, created_by: T, created_at: I },
  },
  study_pictures: {
    cols: ['user_id', 'id', 'topic_id', 'kind', 'r2_key', 'mime', 'bytes', 'doc_id', 'page', 'crop_json', 'caption', 'status', 'sort', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'topic_id', 'kind', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, topic_id: T, kind: ['photo', 'page'], r2_key: T, mime: T, bytes: I, doc_id: T, page: I, crop_json: 'jo', caption: T,
      status: ['active', 'deleted'], sort: I, created_by: T, created_at: I, updated_at: I },
  },
  chat_notes: {
    cols: ['user_id', 'id', 'chat_key', 'source', 'title', 'body', 'topic_ids_json', 'saves', 'created_at', 'updated_at', 'deleted_at'],
    required: ['user_id', 'id', 'source', 'body', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, chat_key: T, source: ['claude', 'paste'], title: T, body: T, topic_ids_json: 'ja', saves: I, created_at: I, updated_at: I, deleted_at: I },
  },
  activity_days: {
    cols: ['user_id', 'day', 'seconds', 'beats', 'first_at', 'last_at'],
    required: ['user_id', 'day', 'first_at', 'last_at'],
    types: { user_id: T, day: T, seconds: I, beats: I, first_at: I, last_at: I },
  },
  subjects: {
    cols: ['user_id', 'id', 'track', 'subject', 'name', 'board', 'tier', 'spec_code', 'exam_year', 'status', 'sort', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'track', 'subject', 'name', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, track: ['gcse', 'alevel', 'language', 'uk_med', 'primary', 'university', 'other'], subject: T, name: T, board: ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'ccea', 'other'],
      tier: ['foundation', 'higher'], spec_code: T, exam_year: I, status: ['active', 'removed'], sort: I, created_at: I, updated_at: I },
  },
  result_logs: {
    cols: ['user_id', 'id', 'bank', 'subject_id', 'day', 'label', 'how', 'rows_json', 'right_n', 'total_n', 'marks', 'out_of', 'batch_id', 'created_at', 'deleted_at'],
    required: ['user_id', 'id', 'bank', 'day', 'how', 'created_at'],
    types: { user_id: T, id: T, bank: T, subject_id: T, day: T, label: T, how: ['screenshot', 'typed', 'claude', 'paper'], rows_json: 'ja',
      right_n: I, total_n: I, marks: R, out_of: R, batch_id: T, created_at: I, deleted_at: I },
  },
  cards: {
    cols: ['id', 'user_id', 'subject_id', 'topic_id', 'front', 'back', 'source', 'ext_id', 'fsrs_json', 'due_at', 'state', 'reps', 'lapses', 'suspended', 'created_at', 'updated_at', 'deleted_at'],
    required: ['user_id', 'front', 'back', 'fsrs_json', 'due_at', 'created_at', 'updated_at'],
    types: { id: I, user_id: T, subject_id: T, topic_id: T, front: T, back: T, source: ['mine', 'ai', 'gap', 'claude', 'paper', 'anki'], ext_id: I, fsrs_json: 'jo',
      due_at: I, state: I, reps: I, lapses: I, suspended: I, created_at: I, updated_at: I, deleted_at: I },
  },
  card_reviews: {
    cols: ['id', 'user_id', 'card_id', 'at', 'rating', 'state_before', 'due_before', 'stability', 'difficulty', 'scheduled_days', 'duration_ms', 'via'],
    required: ['user_id', 'card_id', 'at', 'rating'],
    types: { id: I, user_id: T, card_id: I, at: I, rating: I, state_before: I, due_before: I, stability: R, difficulty: R, scheduled_days: R, duration_ms: I, via: T },
  },
  papers: {
    cols: ['user_id', 'id', 'subject_id', 'title', 'spec_json', 'paper_json', 'marks_json', 'status', 'provider', 'model', 'usd', 'result_id', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'subject_id', 'title', 'paper_json', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, subject_id: T, title: T, spec_json: 'jo', paper_json: 'j', marks_json: 'jo', status: ['ready', 'marking', 'marked'], provider: T, model: T, usd: R,
      result_id: T, created_at: I, updated_at: I },
  },
};

