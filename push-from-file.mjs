// push-from-file.mjs
// Reads reviews.json (created by backfill-fetch.mjs) and pushes to Webflow.
// Uses NO Outscraper credits. Safe to re-run — it skips anything already there.
//
//   WEBFLOW_API_TOKEN='...' WEBFLOW_COLLECTION_ID='...' node push-from-file.mjs
//
// Add DRY_RUN=true to preview without writing.

import { readFileSync } from 'fs';

const { WEBFLOW_API_TOKEN, WEBFLOW_COLLECTION_ID } = process.env;
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!WEBFLOW_API_TOKEN || !WEBFLOW_COLLECTION_ID) {
  console.error('❌ Set WEBFLOW_API_TOKEN and WEBFLOW_COLLECTION_ID');
  process.exit(1);
}

const reviews = JSON.parse(readFileSync('reviews.json', 'utf8'))
  .filter((r) => r.review_text && r.review_text.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function generateStars(rating) {
  const filled = Math.round(rating);
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function makeSlug(review) {
  return (review.author_title + '-' + review.review_id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

const BASE = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`;
const HEADERS = { Authorization: `Bearer ${WEBFLOW_API_TOKEN}`, 'Content-Type': 'application/json' };

// 1. existing slugs (staged view)
const existing = new Set();
let off = 0;
while (true) {
  const r = await wf(`${BASE}?limit=100&offset=${off}`, { headers: HEADERS });
  const d = await r.json();
  if (!r.ok) { console.error('❌ Webflow read failed:', r.status, JSON.stringify(d)); process.exit(1); }
  (d.items || []).forEach((i) => existing.add(i.fieldData?.slug));
  if ((d.items || []).length < 100) break;
  off += 100;
}
console.log(`Reviews with text: ${reviews.length}.  Already in Webflow: ${existing.size}.`);

// 2. push the new ones
let pushed = 0, skipped = 0, failed = 0;
for (const review of reviews) {
  const slug = makeSlug(review);
  if (existing.has(slug)) { skipped++; continue; }

  const payload = {
    fieldData: {
      name: review.author_title,
      body: `"${review.review_text}"`,
      date: new Date(review.review_datetime_utc).toISOString(),
      'author-image': review.author_image || '',
      rating: review.review_rating,
      'google-link': review.review_link || review.author_url || '',
      stars: generateStars(review.review_rating),
      slug,
    },
  };

  if (DRY_RUN) { console.log('🧪 would push:', slug); pushed++; continue; }

  const r = await wf(`${BASE}/live`, { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) });
  if (r.ok) { pushed++; existing.add(slug); console.log(`✅ ${pushed}  ${slug}`); }
  else { failed++; const e = await r.json().catch(() => ({})); console.log(`❌ ${slug} (${r.status})`, JSON.stringify(e).slice(0, 200)); }
  await sleep(600);
}

console.log(`\nDone. pushed: ${pushed}, skipped (already there): ${skipped}, failed: ${failed}`);
