export const config = {
  maxDuration: 60,
};

const VERSION = 'v6-single-fetch';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const placeId = process.env.GOOGLE_PLACE_ID;
  const webflowToken = process.env.WEBFLOW_API_TOKEN;
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;

  const startTime = Date.now();
  const TIME_BUDGET_MS = 50000;

  // How many reviews to request in the SINGLE fetch. Hard-capped so it can never run away.
  // Default 150 covers this client's 122. Override with ?limit= up to 500.
  const REVIEWS_LIMIT = Math.min(parseInt(req.query.limit || '150', 10), 500);

  const timeUp = () => Date.now() - startTime > TIME_BUDGET_MS;

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
        const wait = parseInt(r.headers.get('retry-after') || '4', 10) * 1000;
        await new Promise((res2) => setTimeout(res2, wait));
        continue;
      }
      return r;
    }
  }

  // 1. ONE fetch — no pagination, so no overlap and no runaway possible
  const oRes = await fetch(
    `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(placeId)}&reviewsLimit=${REVIEWS_LIMIT}&async=false`,
    { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY } }
  );
  const oData = await oRes.json();
  const place = oData.data?.[0] || {};
  const raw = place.reviews_data || [];
  const totalReviews = place.reviews ?? place.reviews_count ?? place.reviewsCount ?? null;

  // De-duplicate the fetched set by review_id, keep only ones with text
  const seenIds = new Set();
  const reviews = [];
  for (const r of raw) {
    if (!r.review_id || seenIds.has(r.review_id)) continue;
    seenIds.add(r.review_id);
    if (r.review_text && r.review_text.trim()) reviews.push(r);
  }

  // 2. Read existing slugs (staged view, immediately consistent)
  const existingSlugs = new Set();
  let off = 0;
  while (true) {
    const r = await wf(
      `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100&offset=${off}`,
      { headers: { Authorization: `Bearer ${webflowToken}` } }
    );
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ version: VERSION, error: 'Webflow read failed', status: r.status, response: d });
    const items = d.items || [];
    items.forEach((i) => existingSlugs.add(i.fieldData?.slug));
    if (items.length < 100) break;
    off += 100;
    if (timeUp()) break;
  }

  // 3. Push the ones not already in Webflow
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let done = true;

  for (const review of reviews) {
    const slug = makeSlug(review);
    if (existingSlugs.has(slug)) { skipped++; continue; }
    if (timeUp()) { done = false; break; } // re-run to push the rest (dedup makes this safe)

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

    const wRes = await wf(
      `https://api.webflow.com/v2/collections/${collectionId}/items/live`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${webflowToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (wRes.ok) { pushed++; existingSlugs.add(slug); }
    else { failed++; }
  }

  res.status(200).json({
    version: VERSION,
    done,
    message: done ? 'Complete — all unique reviews are in Webflow.' : 'Time budget reached — re-run to push the rest.',
    totalReviews,
    uniqueWithText: reviews.length,
    pushed,
    skipped,
    failed,
  });
}