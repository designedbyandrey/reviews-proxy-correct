// dedupe-collection.mjs
// Removes duplicate items that Webflow created with a "-N" suffix when a slug
// collided (e.g. keeps "olaf-maass-ci9d", deletes "olaf-maass-ci9d-2").
// It only deletes a "-N" item when the un-suffixed base slug also exists, so
// it can't touch legitimate items. Uses NO Outscraper credits.
//
//   WEBFLOW_API_TOKEN='...' WEBFLOW_COLLECTION_ID='...' node dedupe-collection.mjs
//
// Add DRY_RUN=true to see what it WOULD delete without deleting.

const { WEBFLOW_API_TOKEN, WEBFLOW_COLLECTION_ID } = process.env;
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!WEBFLOW_API_TOKEN || !WEBFLOW_COLLECTION_ID) {
  console.error('❌ Set WEBFLOW_API_TOKEN and WEBFLOW_COLLECTION_ID');
  process.exit(1);
}

const BASE = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`;
const HEADERS = { Authorization: `Bearer ${WEBFLOW_API_TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wf(url, options) {
  while (true) {
    const r = await fetch(url, options);
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '5', 10) * 1000;
      console.log(`   rate limited, waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    return r;
  }
}

// 1. Gather every item (id + slug) from both views
const items = new Map(); // id -> slug
for (const view of ['items', 'items/live']) {
  let off = 0;
  while (true) {
    const r = await wf(`${BASE.replace(/\/items$/, '')}/${view}?limit=100&offset=${off}`, { headers: HEADERS });
    const d = await r.json();
    if (!r.ok) { console.error(`❌ read failed (${view})`, r.status, JSON.stringify(d)); process.exit(1); }
    (d.items || []).forEach((i) => items.set(i.id, i.fieldData?.slug || ''));
    if ((d.items || []).length < 100) break;
    off += 100;
  }
}

const allSlugs = new Set([...items.values()]);
console.log(`Total items: ${items.size}, unique slugs: ${allSlugs.size}`);

// 2. Find "-N" items whose base slug also exists
const toDelete = [];
for (const [id, slug] of items) {
  const m = slug.match(/^(.+)-(\d+)$/);
  if (m && allSlugs.has(m[1])) {
    toDelete.push({ id, slug });
  }
}

console.log(`Duplicates to remove: ${toDelete.length}`);
toDelete.slice(0, 10).forEach((d) => console.log('  ', d.slug));
if (toDelete.length > 10) console.log(`  ...and ${toDelete.length - 10} more`);

if (DRY_RUN) {
  console.log('\n🧪 DRY_RUN — nothing deleted. Remove DRY_RUN=true to delete these.');
  process.exit(0);
}

// 3. Delete them (unpublish from live, then delete the record)
let done = 0;
for (const { id, slug } of toDelete) {
  await wf(`${BASE}/${id}/live`, { method: 'DELETE', headers: HEADERS });
  await sleep(1100);
  const r = await wf(`${BASE}/${id}`, { method: 'DELETE', headers: HEADERS });
  done++;
  console.log(`${r.ok ? '🗑 ' : '⚠️ '} ${done}/${toDelete.length}  ${slug} (${r.status})`);
  await sleep(1100);
}

console.log(`\n✅ Removed ${done} duplicate(s).`);
