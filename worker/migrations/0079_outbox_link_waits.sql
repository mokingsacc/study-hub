UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL, result_json = NULL
  WHERE kind = 'anki_link_card' AND status = 'failed' AND last_error LIKE 'That miss is not in the Anki mistake log yet%';

UPDATE job_runs SET state = 'ok', counts_json = json_set(coalesce(counts_json, '{}'), '$.waited', 1)
  WHERE job = 'outbox' AND ref = 'anki_link_card' AND state = 'failed' AND detail LIKE 'That miss is not in the Anki mistake log yet%';
