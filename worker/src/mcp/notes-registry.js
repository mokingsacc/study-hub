// The Notes connector (I30): a second server on the same Worker and transport (mcp.js), at /mcp/<token> with
// token = first 40 hex of sha256('practice-hub-notes-connector:' + HUB_KEY). It answers 404 unless NOTES = "on".
// Its own list and instructions (the hub connector's list is full and stays exactly as it is), the hub's conventions:
// the {as_of_seq, as_of, ...} envelope, needs_confirm, actor claude, undo by batch, question-bank keys stripped.
import { readOnly, additive, destructive } from './annotations.js';
import { advertise } from './registry.js';
import { notesList, notesRead, notesSee, notesWrite, notesImport } from '../notes/mcp.js';
import { mnemonicsList, mnemonicsWrite } from '../mnemonics/mcp.js';

export const LIST_MAX = 36_000, INSTRUCTIONS_MAX = 2_000;
const REGION = { type: 'string', enum: ['us', 'uk'], description: 'us (default) or uk: only when Mo says it is for the UK.' };
const ID = { type: 'string', minLength: 1, maxLength: 40 };
const NUM = { type: 'number', minimum: -10000000, maximum: 10000000 };
const OP = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['create_book', 'create_section', 'create_page', 'add', 'edit', 'place', 'move', 'delete', 'undo'] },
    name: { type: 'string', maxLength: 120 }, region: REGION, book_id: ID, section_id: ID, title: { type: 'string', maxLength: 200 },
    type: { type: 'string', enum: ['text', 'table'] }, text: { type: 'string', maxLength: 20000 }, style: { type: ['string', 'null'], enum: ['h1', 'h2', 'h3', null] },
    cells: { type: 'array', maxItems: 60, items: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2000 } } },
    id: ID, ids: { type: 'array', minItems: 1, maxItems: 200, items: ID }, x: NUM, y: NUM, w: { type: 'number', minimum: 8, maximum: 20000 },
    h: { type: 'number', minimum: 8, maximum: 50000 }, dx: NUM, dy: NUM, batch_id: { type: 'string', maxLength: 80 },
  },
  required: ['op'],
  additionalProperties: false,
};

const MNEM = {
  type: 'object',
  properties: {
    cue: { type: 'string', maxLength: 60 }, about: { type: 'string', maxLength: 160 }, kind: { type: 'string', enum: ['acronym', 'hook', 'rule'] },
    items: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', properties: { key: { type: 'string', maxLength: 12 }, text: { type: 'string', maxLength: 240 } },
      required: ['text'], additionalProperties: false } },
    category_id: { type: ['string', 'null'], maxLength: 60 }, topics: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 120 } },
    notes: { type: ['string', 'null'], maxLength: 1500 }, source_ref: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
};

export const NOTES_TOOLS = [
  {
    name: 'notes_list', title: 'List or search notes', annotations: readOnly(), cap: 30000, trim: ['notebooks', 'hits'],
    description: 'Mo\'s Notes (his OneNote-style section): notebooks, sections and pages with ids, or with query, search hits (page_id, block_id, snippet). Region us unless he says UK.',
    inputSchema: { type: 'object', properties: { region: REGION, query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    run: (env, user, args) => notesList(env, user, args),
  },
  {
    name: 'notes_read', title: 'Read a page in 2D', annotations: readOnly(), cap: 60000, trim: ['ink', 'blocks'],
    description: 'One page as a 2D layout: blocks {n, id, type text|table|image, x, y, w, h, style, text} and ink clusters {id, stroke_ids, x, y, w, h, tool, colour}. Units are CSS px at zoom 1, x right, y down. Read before you write; use notes_see to look at handwriting.',
    inputSchema: { type: 'object', properties: { page_id: ID }, required: ['page_id'], additionalProperties: false },
    run: (env, user, args) => notesRead(env, user, args),
  },
  {
    name: 'notes_see', title: 'See a page', annotations: readOnly(), raw: true,
    description: 'A picture of the page or a region (x, y, w, h in page units): ink as drawn, blocks as numbered boxes (n matches notes_read), then up to 3 of its pictures, then a legend. Use it to read handwriting and diagrams.',
    inputSchema: { type: 'object', properties: { page_id: ID, x: NUM, y: NUM, w: { type: 'number', minimum: 20, maximum: 100000 }, h: { type: 'number', minimum: 20, maximum: 100000 } },
      required: ['page_id'], additionalProperties: false },
    run: (env, user, args) => notesSee(env, user, args),
  },
  {
    name: 'notes_write', title: 'Change notes', annotations: destructive(), cap: 3000,
    description: 'One change, one undo. ops, in order: create_book {name, region}, create_section {book_id, name}, create_page {section_id, title} (later ops use it), '
      + 'add {type text|table, x, y, w?, text | cells, style h1|h2|h3}, edit {id, text?, style?, cells?}, place {id, x, y, w?, h?} (a block, ink cluster or stroke: tidy and regroup by placing), '
      + 'move {ids, dx, dy}, delete {ids} (over 5 things: needs_confirm, ask Mo), undo {batch_id} alone. page_id names the page for add, edit, place, move and delete. Leave 20+ units between blocks; never overlap Mo\'s ink. Your own words only, never question-bank text.',
    inputSchema: { type: 'object', properties: { page_id: ID, ops: { type: 'array', minItems: 1, maxItems: 100, items: OP },
      confirm_token: { type: 'string', maxLength: 80 }, mo_said: { type: 'string', maxLength: 300 } }, required: ['ops'], additionalProperties: false },
    run: (env, user, args, ctx) => notesWrite(env, user, args, ctx),
  },
  {
    name: 'notes_import', title: 'Import from OneNote', annotations: additive('Import from OneNote'), cap: 4000, trim: ['imported', 'left'],
    description: 'Copies a page, a section or the whole STEP 2 notebook ("STEP 2") from Mo\'s OneNote into Notes, keeping where things sit; 10 pages a call. Importing again updates those pages and keeps what Mo added. Read-only on OneNote; only when Mo asks.',
    inputSchema: { type: 'object', properties: { onenote: { type: 'string', minLength: 1, maxLength: 300, description: 'A OneNote page_id or title, a section name, or "STEP 2".' }, region: REGION },
      required: ['onenote'], additionalProperties: false },
    run: (env, user, args, ctx) => notesImport(env, user, args, ctx),
  },
  {
    name: 'mnemonics_list', title: 'List mnemonics', annotations: readOnly(), cap: 30000, trim: ['mnemonics'],
    description: 'Mo\'s mnemonics: id, cue, about (what it is for), kind, items [{key, text}], subject (category_id), topics, notes, source and how his tests went. category: a map subject id; query: words to find.',
    inputSchema: { type: 'object', properties: { category: { type: 'string', maxLength: 60 }, query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    run: (env, user, args) => mnemonicsList(env, user, args),
  },
  {
    name: 'mnemonics_write', title: 'Change mnemonics', annotations: destructive(), cap: 3000,
    description: 'One change, one undo; send exactly one of: add [{cue, about, kind acronym|hook|rule, items [{key, text}], category_id?, topics? (map topic ids from map_search), notes?, source_ref?}] (up to 100; '
      + 'a source_ref seen before updates that one unless Mo edited it), edit {id, any field}, remove [ids] (over 5: needs_confirm, ask Mo), undo batch_id. source: onenote, ajmonics or claude (default). '
      + 'Check every item is right for current US practice; your own words, never question-bank text.',
    inputSchema: { type: 'object', properties: {
      add: { type: 'array', minItems: 1, maxItems: 100, items: MNEM },
      edit: { type: 'object', properties: { id: ID, ...MNEM.properties }, required: ['id'], additionalProperties: false },
      remove: { type: 'array', minItems: 1, maxItems: 50, items: ID }, undo: { type: 'string', maxLength: 80 },
      source: { type: 'string', enum: ['onenote', 'ajmonics', 'claude'] }, confirm_token: { type: 'string', maxLength: 80 }, mo_said: { type: 'string', maxLength: 300 } },
      additionalProperties: false },
    run: (env, user, args, ctx) => mnemonicsWrite(env, user, args, ctx),
  },
];

export const NOTES_INSTRUCTIONS = [
  'Mo\'s Notes: his OneNote-style notebooks in the Step 2 hub, each page an endless 2D canvas of text, tables, pictures and his Apple Pencil ink.',
  'Find pages with notes_list (query searches). Read a page with notes_read (blocks and ink with x, y, w, h) and look at it with notes_see before you write near his ink or describe a drawing.',
  'notes_write makes one change per call, reversible: reply "undo that" with notes_write {ops: [{op: "undo", batch_id}]}. Deleting more than five things needs Mo\'s yes (needs_confirm: ask him, then call again with confirm_token).',
  'Place new blocks in free space beside what is there, aligned to it; to tidy or regroup, place items. Never move or delete his ink unless he asks.',
  'notes_import copies OneNote pages in when Mo asks; it never changes his OneNote.',
  'Region: notebooks are US unless Mo says the note is for the UK hub.',
  'Write in plain, short sentences in your own words. Never copy question-bank text (stems, options, explanations) into notes.',
].join('\n');

const BY_NAME = new Map(NOTES_TOOLS.map(t => [t.name, t]));
const LISTED = ['name', 'title', 'description', 'inputSchema', 'annotations'];
const LIST = NOTES_TOOLS.map(t => Object.fromEntries(LISTED.map(k => [k, k === 'inputSchema' ? advertise(t[k]) : t[k]])));
// The mnemonics tools are listed only once MNEMONICS is on (I35), so the connector is unchanged until then.
const NOTES_ONLY = LIST.filter(t => !t.name.startsWith('mnemonics_'));
export const listNotesTools = env => (env && env.MNEMONICS === 'on' ? LIST : NOTES_ONLY);

export const NOTES_SERVER = {
  prefix: 'practice-hub-notes-connector:', info: { name: 'step2-practice-hub-notes', version: '1.0.0' }, instructions: NOTES_INSTRUCTIONS,
  toolByName: name => BY_NAME.get(name) || null, listTools: listNotesTools, kick: false, enabled: env => !!env && env.NOTES === 'on',
};
