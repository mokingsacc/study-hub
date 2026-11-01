UPDATE uworld_reviews SET pack_json = NULL, pack_tries = 0 WHERE pile IN ('wrong', 'shaky') AND pack_json IS NOT NULL;
UPDATE uworld_judging SET status = 'packing' WHERE status = 'done';
