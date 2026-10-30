# Does the Study Hub run on Cloudflare's free plan? (checked 30 Oct 2026)

Short answer: yes, for one student, with three things to watch. Limits are from Cloudflare's own pages on 30 Oct 2026.

| Part | Free plan | What one student uses | Verdict |
|---|---|---|---|
| Requests | 100,000 a day | A busy day is about 1,000 to 3,000 (a beat a minute while open, plus pages and their Claude's tools) | Fine |
| CPU per request | 10 ms | Measured locally with 216 topics and 60 cards (database time included, which Cloudflare does not count): map 6.5 ms median (11.8 ms worst), Today 1.9, subject 1.2, cards due 1.7, a card review 1.5, guide 1.5, study days 1.1, beads 0.6 | Fine; the map is the one to watch on a very big course (600+ topics) |
| CPU per cron run | 10 ms | The minute job (scores, library indexing, clean-up) | Watch: a long PDF is indexed in steps; a step over 10 ms fails and is tried again next minute |
| Cron triggers | 5 an account | 1 | Fine |
| D1 (database) | 5 GB in all, 500 MB a database, 5 million rows read and 100,000 written a day | A year of study is well under 100 MB; a day reads tens of thousands of rows | Fine |
| R2 (files) | 10 GB, 1 million writes and 10 million reads a month | Notes, past papers and photos: a few GB at most | Fine |
| Vectorize (meaning search) | 5 million stored dimensions, 30 million queried a month | About 13,000 passages at 384 dimensions (bge-small): roughly 20 ordinary PDFs or 4 big textbooks | Watch: past that, search by words still works; meaning search covers what fits |
| Workers AI | 10,000 neurons a day | Whisper (Record my thinking): 41 neurons a minute, so about 4 hours of recording a day; topic ideas or a screenshot about 150 neurons each | Fine |
| Durable Objects (live updates) | SQLite-backed classes are on the free plan | One (MapLive, new_sqlite_classes) | Fine |
| Workers Builds (deploy on push) | 3,000 build minutes a month | About 2 minutes a deploy | Fine |

## Voice
Record my thinking uses Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`, about 47 neurons a minute): about
3.5 hours a day on the free plan. Your own topic names go in as its spelling hint, so subject words come out right.

## What their Claude costs
Nothing on Cloudflare: their Claude runs on their own Claude plan and talks to the hub through the connector, so the
heavy thinking (teaching, marking, writing papers, setting up) is never on the hub's free allowance.

## If a limit is ever hit
- Daily D1 or Workers AI limits reset at midnight UTC; the hub shows its plain-words error until then.
- Workers Paid is $5 a month and lifts the CPU limit to 30 seconds and raises everything else; it is the fix if a
  very large course makes the map or library indexing slow.
