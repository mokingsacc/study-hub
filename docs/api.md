# Study Hub API contract (v1)

The shapes every work package builds to (plan §16). Back-end packages return exactly these; the front end reads exactly
these. All JSON. Errors: `{error: "plain words"}` with a 4xx/5xx status. Signed-in routes need the session cookie, and
writes need `X-CSRF-Token` (from `GET /api/auth/me` or the sign-in reply). A switched-off module answers 404
`{error: "This part is switched off. You can turn it on in Settings."}`. Ids are strings unless noted.

Common pieces:
- `Band`: `"Strong" | "Getting there" | "Shaky" | "Weak" | "Very weak" | null` (null = not seen yet); `t1000` is 0-1000
  weakness (higher = weaker) or null. Colour comes from `public/js/map/scale.js`, always shown beside the band word.
- `Subject`: `{id, subject, name, track, board, board_name, tier, spec_code, exam_year, status, topics_n, seen_n, weak_n, ring}`
  where `ring` is 0-1 (share of the subject's topics seen and not Weak/Very weak).
- `TopicChip`: `{id, name, band, t1000, seen}`.

## Lead (built)
| Route | Body | Reply |
|---|---|---|
| `POST /api/auth/invite` | `{token, password}` | `{user, name, profile, must_change: false, csrf}` + cookie |
| `POST /api/auth/login` | `{username, password}` | same |
| `GET /api/auth/me` | | `{user, name, profile, must_change, csrf}` (401 when signed out) |
| `POST /api/auth/logout` | | `{ok}` |
| `POST /api/auth/password` | `{current, password}` | `{ok}` |
| `POST /api/auth/reset` | `{username, code, password}` | `{ok}` |
| `POST /api/auth/reset/email` | `{email}` | `{message}` (404 when email resets are off) |
| `POST /api/auth/reset/email/confirm` | `{token, password}` | `{ok}` |
| `PUT /api/p/email` | `{email}` | `{has_email}` |
| `GET /api/p/ai` | | `{provider, provider_name, model, caps: {daily_usd, monthly_usd, ceiling_usd}, spend: {today_usd, month_usd, calls_today}, keys: [{provider, hint, status, checked_at}], providers: [{id, name, needs_key, models: [{id, label}]}]}` |
| `PUT /api/p/ai` | `{provider?, model?, daily_cap_usd?, monthly_cap_usd?}` | as GET |
| `PUT /api/p/ai/keys/:provider` | `{key}` | `{provider, hint, status}` (status `ok`, `invalid`, `no_credit`, `unchecked`) |
| `DELETE /api/p/ai/keys/:provider` | | `{ok}` |
| `POST /api/p/ai/keys/:provider/check` | | `{provider, status}` |
| `GET /api/p/connector` | | `{links: [{id, label, created_at, last_used_at}]}` |
| `POST /api/p/connector` | `{label}` | `{id, url, shown_once: true}` (201; the url is shown once) |
| `DELETE /api/p/connector/:id` | | `{ok}` |
| `GET /api/p/self-check` | | `{ok, summary, items: [{id, ok, level: "ok"/"info"/"warn"/"stop", says, fix?}]}` |

Invite links look like `https://<host>/#invite=<token>`; email reset links `https://<host>/platform.html#reset=<token>`.

## WP1 Subjects and map (`platform/subjects.js`, `catalogue.js`, `profiles.js`)
| Route | Body | Reply |
|---|---|---|
| `GET /api/p/catalogue` | | `{track, track_label, boards: [{id, name}], subjects: [{id, name, boards: [ids], tiers?: ["foundation","higher"], sections: [names]}], defaults: [subject ids], max}` |
| `GET /api/p/subjects` | | `{subjects: [Subject]}` (active only, by sort) |
| `POST /api/p/subjects` | `{subject, board?, tier?, name?}` (subject = catalogue id, or `"custom"` with `name`) | `{subject: Subject, batch_id}` (201) |
| `GET /api/p/subjects/:id` | | `{subject: Subject, sections: [{id, name, topics: [TopicChip]}], unplaced: n}` |
| `PATCH /api/p/subjects/:id` | `{board?, tier?, spec_code?, exam_year?, name?}` | `{subject: Subject, batch_id}` |
| `DELETE /api/p/subjects/:id` | | `{ok, batch_id}` (undo with `POST /api/p/undo`) |
| `POST /api/p/subjects/:id/suggest` | `{section?, from_item?}` | `{sections: [{name, topics: [{name}]}], provider, usd}` (preview, writes nothing) |
| `POST /api/p/subjects/:id/topics` | `{sections: [{name, topics: [{name}]}]}` | `{added: n, skipped: n, batch_id}` |
| `GET /api/p/topics/:id` | | `{topic: {id, name, subject_id, section, band, t1000, seen, status}, recent: [{day, kind, result, source, label}], cards_n, gaps: [{at, gap}]}` |
| `PATCH /api/p/topics/:id` | `{name?, section?, retired?: true}` | `{topic, batch_id}` |
| `GET /api/p/today` | | `{name, track_label, days_to_exam: n or null, subjects: [{id, name, board_name, ring, weak_n}], weakest: [TopicChip & {subject_id, subject_name}] (up to 5), cards_due: n, last_results: [{id, bank, subject_id, day, label, right_n, total_n, marks, out_of}], modules: {id: bool}}` |
| `POST /api/p/gaps` | `{gap, topic?, subject_id?}` | `{ok, gap_id, placed: bool}` |
| `POST /api/p/undo` | `{batch_id}` or `{last: 1}` | `{ok, undone: n}` |
Tools: `study_overview`, `subject_topics`, `topic_detail`, `add_topics`, `log_gap`.

## WP2 Results and library (`platform/banks.js`, `results.js`, `library.js`)
| Route | Body | Reply |
|---|---|---|
| `GET /api/p/banks` | | `{banks: [{id, name, how: ["screenshot","typed"], steps: [lines], hint}]}` (the person's track only) |
| `POST /api/p/results/read` | `{bank, subject_id, images: ["data:image/jpeg;base64,...", ...] (max 4)}` | `{rows: [Row], provider, usd}` (preview; nothing stored) |
| `POST /api/p/results` | `{bank, subject_id, day: "YYYY-MM-DD", label?, how: "screenshot"/"typed", rows: [Row]}` | `{id, saved: n, placed: n, unplaced: n, batch_id}` (201) |
| `GET /api/p/results` | `?subject_id=&limit=` | `{results: [{id, bank, bank_name, subject_id, day, label, how, right_n, total_n, marks, out_of}]}` |
| `DELETE /api/p/results/:id` | | `{ok}` |
| `GET /api/p/library` | `?subject_id=&type=` | `{items: [Item], used_bytes, max_bytes}` |
| `POST /api/p/library` | multipart `file` + `title`, `subject_id?`, `doc_type?`; or JSON `{kind: "link", url, title, subject_id?, doc_type?}` / `{kind: "note", title, text, subject_id?, doc_type?}` | `{item: Item}` (201) |
| `GET /api/p/library/:id` | | `{item: Item, text: string (first 20,000 chars) or null}` |
| `PATCH /api/p/library/:id` | `{title?, subject_id?, doc_type?}` | `{item: Item}` |
| `DELETE /api/p/library/:id` | | `{ok}` |
| `GET /api/p/library/:id/file` | | the file bytes (private, no-store) |
| `GET /api/p/library/search` | `?q=&subject_id=` | `{hits: [{item_id, title, page, n, snippet}]}` (snippet marks matches with `[` and `]`) |
`Row`: `{q, result: "right"/"wrong"/"partial"/"omitted"/null, marks, out_of, topic, section, others_pct}` (numbers and
short labels only). `Item`: `{id, kind, title, subject_id, doc_type, filename, mime, size, pages, url, text_status, created_at}`.
Tools: `log_results`, `library_search`, `library_read`.

## WP3 Cards and me (`platform/cards.js`, `me.js`, `papers.js` stretch)
| Route | Body | Reply |
|---|---|---|
| `GET /api/p/cards/due` | `?subject_id=&limit=20` | `{cards: [{id, front, back, subject_id, topic_id, state, due_at}], due_n, new_n}` |
| `GET /api/p/cards/stats` | | `{total, due_now, due_today, new, learning, review, reviewed_today, streak_days}` |
| `GET /api/p/cards` | `?subject_id=&topic_id=&q=` | `{cards: [{id, front, back, subject_id, topic_id, source, due_at, state, lapses}]}` |
| `POST /api/p/cards` | `{front, back, subject_id?, topic_id?}` | `{card}` (201) |
| `POST /api/p/cards/draft` | `{from: "gap"/"topic"/"text", text?, topic_id?, subject_id?}` | `{drafts: [{front, back}], usd}` (AI; nothing stored) |
| `PATCH /api/p/cards/:id` | `{front?, back?, topic_id?, suspended?}` | `{card}` |
| `DELETE /api/p/cards/:id` | | `{ok}` |
| `POST /api/p/cards/:id/review` | `{rating: 1-4, duration_ms?}` | `{card: {id, due_at, state}, next: card or null, due_n}` |
| `GET /api/p/me` | | `{user, name, track, track_label, exam_date, email_set, modules: [{id, label, on, can_switch}]}` |
| `PATCH /api/p/me` | `{name?, exam_date?, modules?: {id: bool}}` | as GET |
| `GET /api/p/me/export` | | a JSON download of every row with their user_id (+ the file list) |
| `POST /api/p/me/delete` | `{password}` | `{ok, message}` (signed out; data purged within 24 h) |
Tools: `cards_add`, `cards_next`, `card_rate`. `cards.js` keeps `dueCount(env, user)`.

## v2 (29 Oct; `docs/platform/v2-plan.md`)
| Route | Body | Reply |
|---|---|---|
| `GET /api/p/galaxies` | | `{galaxies: [{id, title, sort, created_by, n, seen_n, weak_n, ring}], order: [{kind: galaxy\|subject, id, title, n, weak_n, ring}], layout, max}` |
| `GET /api/p/galaxies/:id` | | `{galaxy, subjects: [{id, name, topics: [TopicChip + subject_id, section]}]}` |
| `POST /api/p/galaxies` | `{ops: [{op: create\|rename\|add\|remove\|new_topics\|delete\|order, ...}]}` (10 at most) | `{batch_id, created?, ...}`; one undo |
| `GET /api/p/topics` | | `{topics: [TopicChip + subject_id, section, galaxy]}` |
| `GET /api/p/guide` | | `{track, track_label, name, subjects: [{id, subject, name, board, board_name, tier, topics_n, weak_n, weakest}], counts: {topics, galaxies, docs, cards_due, papers_to_sit, papers_marked}, days_to_exam, exam_date, claude: {links, last_used_at}, setup: {claude, boards_missing, no_topics, exam_date}, modules}` |
| `GET /api/p/recent?days=7` | | `{days, items: [{batch_id, at, who: You\|Your Claude\|The hub\|Anki, what, more, undoable, undone}]}` |
| `GET /api/p/map/recent?hours=1\|24\|168` | | `{hours, since, topics: [{id, at, what, n}]}` |
| `GET /api/p/topics/:id/pictures` | | `{pictures: [{id, topic_id, kind: photo\|page, caption, doc_id, page, crop, url, doc_title, created_by, created_at}], max: 12}` |
| `PUT /api/p/pictures?topic=&caption=` | the image (JPEG, PNG or WebP, 5 MB) | 201 `{picture, batch_id}` |
| `POST /api/p/pictures` | `{topic, doc_id, page, crop?: {x, y, w, h}, caption?}` | 201 `{picture, batch_id}` |
| `PATCH /api/p/pictures/:id` | `{caption}` | `{picture}` |
| `DELETE /api/p/pictures/:id` | | `{ok, batch_id}` (undo with `POST /api/p/undo`) |
| `GET /api/p/pictures/:id/file` | | the photo |
| `GET /api/p/cards/due` | | adds `learning_n`, `review_n`; each card adds `queue` and `intervals: {1..4: '1m'}` |

New connector tools: `paper_make`, `galaxy_edit`, `hub_guide`, `subject_edit`, `topic_edit`, `card_edit`, `topic_picture`.
