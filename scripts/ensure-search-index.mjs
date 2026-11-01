// Makes the library's search index if it is missing (384 dimensions, cosine: the embedding model's), before a deploy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const toml = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const name = (/\[\[vectorize\]\][^[]*?index_name\s*=\s*"([^"]+)"/.exec(toml) || [])[1];
const run = args => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (name) {
  try { run(['vectorize', 'get', name]); console.log('Search index ' + name + ': there'); }
  catch {
    try { run(['vectorize', 'create', name, '--dimensions=384', '--metric=cosine']); console.log('Search index ' + name + ': made'); }
    catch (e) { console.log('Search index ' + name + ': could not be made (' + String(e.stderr || e.message).split('\n')[0] + '). Make it in Cloudflare: AI, Vectorize, 384 dimensions, cosine.'); }
  }
}
