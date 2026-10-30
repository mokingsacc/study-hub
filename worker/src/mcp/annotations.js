export const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };

/** A tool that only reads (map_overview counts: it writes only its own seen-marker). */
export const readOnly = () => ({ readOnlyHint: true, openWorldHint: false });

export const additive = (title, { idempotent = false } = {}) => ({ readOnlyHint: false, destructiveHint: false, ...(idempotent ? { idempotentHint: true } : {}), openWorldHint: false });

/** A write that can retire, remove or reverse: map_update_topic, map_update_link, map_merge_topics and hub_undo. */
export const destructive = () => ({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
