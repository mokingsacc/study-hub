// Cards (#cards, worker/src/cards.js): Anki review in the hub. Its routes are the hub's own (router.js); its one
// table only keeps ratings from being sent twice.
export const EXPORT_SKIP = {
  card_rates: 'Idempotency keys for ratings sent to Anki, kept 30 days: Anki holds the ratings themselves.',
};
