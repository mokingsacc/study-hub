-- What kind of exam a sitting is, for the predictor: set from the sitting form. NULL on older rows,
-- where the hub falls back to guessing from the name (public/js/hub/predict-input.js).
ALTER TABLE sittings ADD COLUMN exam_type TEXT CHECK (exam_type IS NULL OR exam_type IN ('nbme', 'uwsa', 'free120', 'uworld_avg', 'hub', 'other'));
