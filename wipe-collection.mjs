// wipe-collection.mjs
// Deletes ALL items from a Webflow collection so you can re-run a clean backfill.
// Throttled to respect Webflow's rate limit (~60 req/min) and retries on 429.
//
// Run:
//   WEBFLOW_API_TOKEN='...' WEBFLOW_COLLECTION_ID='...' node wipe-collection.mjs
//
// This is destructive. It removes every item in the collection (live + staged).

const { WEBFLOW_API_TOKEN, WEBFLOW_COLLECTION_ID } = process.env;

if (!WEBFLOW_API_TOKEN || !WEBFLOW_COLLECTION_ID) {
  console.error('❌ Set WEBFLOW_API_TOKEN and WEBFLOW_COLLECTION_ID');
  process.exit(1);
}

const BASE = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`;
const HEADERS = { Authorization: `Bearer ${WEBFLOW_API_TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch wrapper that backs off on 429 (rate limit)
async function call(url, options) {
  while (true) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '5', 10) * 1000;
      console.log(`   rate limited, waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    return res;
  }
}

async function main() {
  // 1. Collect every item id (paginate)
  const ids = [];
  let offset = 0;
  while (true) {
    const res = await call(`${BASE}?limit=100&offset=${offset}`, { headers: HEADERS });
    const data = await res.json();
    if (!res.ok) {
      console.error('❌ List failed:', res.status, JSON.stringify(data));
      return;
    }
    const items = data.items || [];
    items.forEach((i) => ids.push(i.id));
    if (items.length < 100) break;
    offset += 100;
  }

  console.log(`Found ${ids.length} item(s) to delete.\n`);
  if (!ids.length) return;

  // 2. Delete each (unpublish from live, then delete the record)
  let done = 0;
  for (const id of ids) {
    await call(`${BASE}/${id}/live`, { method: 'DELETE', headers: HEADERS }); // unpublish
    await sleep(1100);
    const res = await call(`${BASE}/${id}`, { method: 'DELETE', headers: HEADERS }); // delete
    done++;
    console.log(`${res.ok ? '🗑 ' : '⚠️ '} ${done}/${ids.length}  ${id}  (${res.status})`);
    await sleep(1100);
  }

  console.log('\n✅ Collection wiped. Now re-run your backfill with the fixed handler.');
}

main().catch((e) => {
  console.error('💥', e);
  process.exit(1);
});
