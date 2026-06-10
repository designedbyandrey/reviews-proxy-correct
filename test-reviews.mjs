// test-reviews.mjs
// Quick local test of the Outscraper -> Webflow pipeline, using the SAME logic
// as your production sync-reviews handler — just capped at 3 reviews so you can
// verify a new client's config before deploying.
//
// Run a safe preview first (no writes to Webflow):
//   DRY_RUN=true node test-reviews.mjs
//
// Then run for real (pushes up to 3 new reviews to Webflow):
//   node test-reviews.mjs
//
// Reads the SAME env vars your Vercel function uses.

const {
  OUTSCRAPER_API_KEY,
  GOOGLE_PLACE_ID,
  WEBFLOW_API_TOKEN,
  WEBFLOW_COLLECTION_ID,
} = process.env;

const DRY_RUN = process.env.DRY_RUN === 'true';
const TEST_LIMIT = 3; // only fetch a handful for testing

function generateStars(rating) {
  const filled = Math.round(rating);
  const empty = 5 - filled;
  return '★'.repeat(filled) + '☆'.repeat(empty);
}

async function main() {
  // 0. Sanity-check that every env var is present
  const required = { OUTSCRAPER_API_KEY, GOOGLE_PLACE_ID, WEBFLOW_API_TOKEN, WEBFLOW_COLLECTION_ID };
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      console.error(`❌ Missing env var: ${key}`);
      process.exit(1);
    }
  }
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will write to Webflow)'}\n`);

  // 1. Fetch a few reviews from Outscraper
  //    NOTE: reviews-v3 uses `limit` for the number of reviews (same as your working prod code)
  console.log(`📥 Fetching ${TEST_LIMIT} reviews from Outscraper for place ${GOOGLE_PLACE_ID}...`);
  const outscraperRes = await fetch(
    `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(GOOGLE_PLACE_ID)}&limit=${TEST_LIMIT}&async=false`,
    { headers: { 'X-API-KEY': OUTSCRAPER_API_KEY } }
  );
  const outscraperData = await outscraperRes.json();
  const reviews = outscraperData.data?.[0]?.reviews_data || [];
  console.log(`   → HTTP ${outscraperRes.status}, got ${reviews.length} review(s)`);

  if (!reviews.length) {
    console.log('\n⚠️  No reviews parsed. Raw Outscraper response below — look for an error message, a "Pending" status, or a different data shape:\n');
    console.log(JSON.stringify(outscraperData, null, 2).slice(0, 2000));
    return;
  }

  // 2. Same filter as production: no length limit, just keep reviews that have text
  const filtered = reviews.filter(r => r.review_text && r.review_text.trim().length > 0);
  console.log(`   → ${filtered.length} have text\n`);

  // 3. Pull existing slugs so we don't create duplicates (test reads first page only)
  const existingRes = await fetch(
    `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/live?limit=100`,
    { headers: { Authorization: `Bearer ${WEBFLOW_API_TOKEN}` } }
  );
  const existingData = await existingRes.json();
  if (!existingRes.ok) {
    console.error(`❌ Webflow read failed (${existingRes.status}):`, JSON.stringify(existingData, null, 2));
    console.error('   → Check WEBFLOW_API_TOKEN scopes and WEBFLOW_COLLECTION_ID.');
    return;
  }
  const existingSlugs = (existingData.items || []).map(i => i.fieldData.slug);

  // 4. Build + (optionally) push each review
  for (const review of filtered) {
    const slug =
      review.author_title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + review.review_id;

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

    console.log('─'.repeat(60));
    console.log(JSON.stringify(payload, null, 2));

    if (existingSlugs.includes(slug)) {
      console.log(`⏭  skipped (already in collection): ${slug}`);
      continue;
    }
    if (DRY_RUN) {
      console.log('🧪 DRY_RUN — would POST this, but not writing.');
      continue;
    }

    const webflowRes = await fetch(
      `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/live`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
    const webflowData = await webflowRes.json();
    const ok = webflowRes.ok ? '✅' : '❌';
    console.log(`${ok} Webflow responded ${webflowRes.status}:`, JSON.stringify(webflowData, null, 2));
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('💥 Error:', err);
  process.exit(1);
});
