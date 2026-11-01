
export const FACT_ORDER = ['uworld', 'first-aid', 'mehlman'];
export const factRank = coll => { const i = FACT_ORDER.indexOf(coll || ''); return i < 0 ? FACT_ORDER.length : i; };

export const NOT_CHECKED = 'from memory, not checked';

const SHORT = [
  [/^UW Tables(?: & Images)?/i, 'UW Tables'], [/^UW Objectives/i, 'UW Objectives'],
  [/^FA Clinical Algorithms/i, 'FA Algorithms'], [/^FA for Step 2 ?CK/i, 'FA'], [/^First Aid/i, 'FA'],
  [/^HY /, 'Mehlman HY '], [/^Divine Intervention/i, 'Divine'],
];

export function tagOf(cite) {
  const s = String(cite || '').trim();
  if (!s) return null;
  const m = /^(.*?),\s*pp?\.\s*(\d+)/.exec(s);
  let title = (m ? m[1] : s.split(' — ')[0]).trim();
  for (const [re, short] of SHORT) if (re.test(title)) { title = title.replace(re, short).trim(); break; }
  return m ? `${title} p. ${m[2]}` : title.slice(0, 60);
}

export const SOURCE_RULE = 'Facts are decided in this order: 1 UWorld (his library\'s UW Objectives and UW Tables & Images, and the brief\'s uworld_objectives); '
  + '2 First Aid for Step 2 CK (his library); 3 Mehlman for what the NBME tests and its traps, not the last word when UWorld or First Aid disagree; 4 AnKing cards. '
  + 'When two disagree, teach the US-guideline answer (usually UWorld, updated continuously) and say so, naming both. '
  + 'Every deciding line (rules in or out, "means", always or never, a cut-off or number, a first-line test or drug) carries a short tag such as (UW Tables p. 211), (FA p. 567) or (Mehlman HY Peds p. 17). '
  + `No source found: say "${NOT_CHECKED}" and keep it off any card. UWorld library passages may be paraphrased and cited; never question stems or options.`;

export const AMBOSS_RULE = 'Only when the browser tools are there (Claude in Chrome, or Claude Code with /chrome): before the opening viva, silently, in 30 to 60 seconds, open this amboss_url in a new tab '
  + '(missing or a 404: the AMBOSS search page for the topic name); read the summary, clinical features, diagnostics, differential diagnosis, treatment and complications; '
  + 'keep a private list of the deciding facts with their section headings and cite them as (AMBOSS: <section heading>). Then UWorld, First Aid, Mehlman. '
  + 'Paraphrase; never copy AMBOSS text into the hub, a card or a note. A login page, or no browser tools (voice, the Claude app, the nightly session): start at UWorld, without comment.';
