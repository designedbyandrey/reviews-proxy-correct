// backfill-fetch.mjs
// Runs LOCALLY (no 60s limit), so one big fetch is fine. Makes ONE Outscraper
// request, dedupes, and saves everything to reviews.json. This is the only step
// that spends Outscraper credits — run it once.
//
//   OUTSCRAPER_API_KEY='...' GOOGLE_PLACE_ID='ChIJ...' node backfill-fetch.mjs
//
// Optional: LIMIT=300 to request more (default 200, plenty for ~122).

import { writeFileSync } from 'fs';

const { OUTSCRAPER_API_KEY, GOOGLE_PLACE_ID } = process.env;
const LIMIT = Math.min(parseInt(process.env.LIMIT || '200', 10), 1000);

if (!OUTSCRAPER_API_KEY || !GOOGLE_PLACE_ID) {
  console.error('❌ Set OUTSCRAPER_API_KEY and GOOGLE_PLACE_ID');
  process.exit(1);
}

console.log(`Fetching up to ${LIMIT} reviews in ONE request (this may take a minute)...`);

const url = `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(GOOGLE_PLACE_ID)}&reviewsLimit=${LIMIT}&async=false`;
const res = await fetch(url, { headers: { 'X-API-KEY': OUTSCRAPER_API_KEY } });
const data = await res.json();

if (!res.ok || data.error) {
  console.error('❌ Outscraper error:', res.status, JSON.stringify(data).slice(0, 500));
  process.exit(1);
}

const place = data.data?.[0] || {};
const raw = place.reviews_data || [];
const reported = place.reviews ?? place.reviews_count ?? place.reviewsCount ?? '(unknown)';

// de-dupe by review_id
const seen = new Set();
const reviews = [];
for (const r of raw) {
  if (r.review_id && !seen.has(r.review_id)) {
    seen.add(r.review_id);
    reviews.push(r);
  }
}

writeFileSync('reviews.json', JSON.stringify(reviews, null, 2));

const withText = reviews.filter((r) => r.review_text && r.review_text.trim()).length;
console.log(`\nPlace reports:     ${reported} reviews`);
console.log(`Records returned:  ${raw.length}`);
console.log(`Unique reviews:    ${reviews.length}`);
console.log(`With text:         ${withText}`);
console.log(`\n✅ Saved to reviews.json — now run push-from-file.mjs (no more credits used).`);
