-- Pictures cut out of uploaded PDFs (an ECG, an X-ray...). A question lists its pictures by id in
-- questions_json (figs: [{id, label, where}]). Uploaded before the exam is saved (exam_id NULL), then
-- attached by POST /api/exams; unattached ones are removed by the cron after a day.
CREATE TABLE exam_images (id TEXT PRIMARY KEY, exam_id TEXT, mime TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_exam_images_exam ON exam_images (exam_id);
