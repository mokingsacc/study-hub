// "Is everything working?" in plain words (GET /api/p/check and the self_check connector tool). Each item is
// {id, ok, level: 'ok'|'info'|'warn'|'stop', says, fix?}. Core items here (AI provider and key, spending,
// reset email, Claude connector); feature modules add theirs through features.checks(). A check that throws
// is reported as one item, never as a failed page.
import * as ai from './ai.js';
import * as features from './features.js';

async function aiItems(env, user) {
  const ov = await ai.aiOverview(env, user);
  const out = [];
  if (ov.provider === 'workers_ai') {
    out.push(env.AI && typeof env.AI.run === 'function'
      ? { id: 'ai', ok: true, level: 'ok', says: 'AI: using the built-in AI. Nothing to set up.' }
      : { id: 'ai', ok: false, level: 'stop', says: 'AI: the built-in AI is not available on this hub right now.', fix: 'Tell Mo.' });
  } else {
    const k = ov.keys.find(x => x.provider === ov.provider);
    const name = ov.provider_name;
    if (!k) out.push({ id: 'ai', ok: false, level: 'stop', says: `AI: you chose ${name} but no key is saved.`, fix: 'Add your key in Settings, or switch to the built-in AI.' });
    else if (k.status === 'invalid') out.push({ id: 'ai', ok: false, level: 'stop', says: `AI: your ${name} key is not valid (${k.hint}).`, fix: 'Copy a fresh key from the provider and save it again, or switch to the built-in AI.' });
    else if (k.status === 'no_credit') out.push({ id: 'ai', ok: false, level: 'stop', says: `AI: your ${name} account has no credit left.`, fix: 'Top up your account, or switch to the built-in AI.' });
    else if (k.status === 'unchecked') out.push({ id: 'ai', ok: true, level: 'info', says: `AI: your ${name} key (${k.hint}) has not been checked yet.`, fix: 'Tap Check key in Settings.' });
    else out.push({ id: 'ai', ok: true, level: 'ok', says: `AI: ${name} (${ov.model}) with your key ${k.hint}.` });
  }
  const s = { daily_cap_usd: ov.caps.daily_usd, monthly_cap_usd: ov.caps.monthly_usd, admin_cap_usd: ov.caps.ceiling_usd };
  const cap = ai.capProblem(s, { today: ov.spend.today_usd, month: ov.spend.month_usd });
  if (cap) out.push({ id: 'spend', ok: false, level: 'stop', says: `Spending: ${cap}` });
  else if (ov.caps.daily_usd > 0 && ov.spend.today_usd >= 0.8 * ov.caps.daily_usd) out.push({ id: 'spend', ok: true, level: 'warn', says: `Spending: $${ov.spend.today_usd.toFixed(2)} of today's $${ov.caps.daily_usd.toFixed(2)} limit used.` });
  else out.push({ id: 'spend', ok: true, level: 'ok', says: `Spending: $${ov.spend.today_usd.toFixed(2)} today, $${ov.spend.month_usd.toFixed(2)} this month (limits $${ov.caps.daily_usd.toFixed(2)} a day, $${ov.caps.monthly_usd.toFixed(2)} a month).` });
  return out;
}

async function accountItems(env, user) {
  const [cred, links] = await Promise.all([
    env.DB.prepare('SELECT email IS NOT NULL AS has_email FROM credentials WHERE user_id = ?').bind(user).first(),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(last_used_at) AS used FROM connector_keys WHERE user_id = ? AND revoked_at IS NULL AND coalesce(label, '') != 'anki'").bind(user).first(),
  ]);
  return [
    links && links.n > 0 && links.used
      ? { id: 'connector', ok: true, level: 'ok', says: 'Claude: connected, and your Claude has reached your hub.' }
      : links && links.n > 0
        ? { id: 'connector', ok: true, level: 'info', says: 'Claude: your link is made but your Claude has not used it yet.', fix: 'In the Claude app: Settings, Connectors, add it as a custom connector, then switch Study Hub on in a chat.' }
        : { id: 'connector', ok: true, level: 'info', says: 'Claude: not linked yet.', fix: 'Make a connector link in Settings and add it to Claude as a custom connector.' },
    cred && cred.has_email
      ? { id: 'email', ok: true, level: 'ok', says: 'Password reset: your email is saved.' }
      : { id: 'email', ok: true, level: 'info', says: 'Password reset: no email saved, so ask Mo for a reset code if you forget your password.' },
  ];
}

export async function selfCheck(env, user) {
  const runs = [aiItems, accountItems, ...features.checks()];
  const parts = await Promise.all(runs.map(fn => Promise.resolve().then(() => fn(env, user)).catch(e => {
    console.error('self-check item failed', fn.name, e && e.message);
    return [{ id: fn.name || 'check', ok: false, level: 'warn', says: 'One check could not run just now. Try again in a minute.' }];
  })));
  const items = parts.flat();
  const order = { stop: 0, warn: 1, info: 2, ok: 3 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  const stops = items.filter(i => i.level === 'stop').length;
  return { ok: stops === 0, summary: stops ? `${stops} thing${stops > 1 ? 's' : ''} need${stops > 1 ? '' : 's'} fixing.` : 'Everything is working.', items };
}

// The connector tool, for Claude to answer "why isn't it working?".
export const SELF_CHECK_TOOL = {
  name: 'self_check',
  description: "Checks the user's study hub setup (AI key, spending limits, flashcards, Anki link, connector) and says in plain words what is wrong and how to fix it.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run: (env, user) => selfCheck(env, user),
};
