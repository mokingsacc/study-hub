DROP VIEW IF EXISTS board_misses;
CREATE VIEW board_misses AS
SELECT m.id, m.user_id, m.day, m.at, m.label, m.topic_raw, m.source, m.qbank, m.sitting_id, m.anki_mistake_id,
       m.error_type, m.confidence, m.result, m.outcome, m.time_s, m.slow, (m.confidence = 'sure' AND m.result = 'wrong') AS sure_wrong,
       m.rule, m.my_reasoning, m.look_alikes, m.learning_point, m.right_reasoning, m.retests_json, m.next_retest_day, m.anki_note_ids_json,
       m.reviewed_at, m.reviewed_by, m.match_status, m.flaw_kind, m.created_at, m.block_id, m.q_index,
       t.id AS topic_id, t.name AS topic, t.status AS topic_status, coalesce(t.category_id, m.category_id) AS category_id, t.amboss_url,
       u.id AS unit_id, u.num AS unit_num, u.name AS unit, u.lane, u.mehlman_rank, u.yield AS unit_yield,
       coalesce(u.checklist_system, c.checklist_system) AS checklist_system, u.checklist_order, m.uw_qid
FROM misses_live m
LEFT JOIN topics t0 ON t0.user_id = m.user_id AND t0.id = m.topic_id
LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = CASE WHEN t0.status = 'merged' THEN t0.merged_into ELSE t0.id END
                  AND t.status IN ('proposed','confirmed')
LEFT JOIN units u ON u.user_id = m.user_id AND u.id = t.unit_id
LEFT JOIN categories c ON c.user_id = m.user_id AND c.id = coalesce(t.category_id, m.category_id);
