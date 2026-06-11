export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const placeId = process.env.GOOGLE_PLACE_ID;
  const webflowToken = process.env.WEBFLOW_API_TOKEN;
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;

  const startTime = Date.now();
  const TIME_BUDGET_MS = 45000;  // stop well before the 60s hard limit and report progress
  const REVIEWS_PER_PAGE = 50;   // small page = fast Outscraper call (500 was timing out)

  // Resume point. Pass ?skip=N to continue a backfill where a previous run stopped.
  let skip = parseInt(req.query.skip || '0', 10);

  function generateStars(rating) {
    const filled = Math.round(rating);
    const empty = 5 - filled;
    return '★'.repeat(filled) + '☆'.repeat(empty);
  }

  function timeUp() {
    return Date.now() - startTime > TIME_BUDGET_MS;
  }

  // 1. Read existing slugs once (paginated) so we don't create duplicates
  const existingSlugs = new Set();
  let wfOffset = 0;
  while (true) {
    const existingRes = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items/live?limit=100&offset=${wfOffset}`,
      { headers: { Authorization: `Bearer ${webflowToken}` } }
    );
    const existingData = await existingRes.json();
    if (!existingRes.ok) {
      return res.status(502).json({ error: 'Webflow read failed', status: existingRes.status, response: existingData });
    }
    const items = existingData.items || [];
    items.forEach(i => existingSlugs.add(i.fieldData.slug));
    if (items.length < 100) break;
    wfOffset += 100;
    if (timeUp()) break;
  }

  let pushed = 0;
  let skipped = 0;
  const results = [];

  const stopHere = (done, msg) =>
    res.status(200).json({ done, message: msg, nextSkip: skip, pushed, skipped, results });

  // 2. Walk reviews in small pages, pushing as we go, until we run out or run low on time
  while (true) {
    if (timeUp()) return stopHere(false, `Time budget reached. Re-run with ?skip=${skip} to continue.`);

    const outscraperRes = await fetch(
      `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(placeId)}&reviewsLimit=${REVIEWS_PER_PAGE}&skip=${skip}&sort=newest&async=false`,
      { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY } }
    );
    const outscraperData = await outscraperRes.json();
    const batch = outscraperData.data?.[0]?.reviews_data || [];

    if (!batch.length) return stopHere(true, 'No more reviews — backfill complete.');

    for (const review of batch) {
      if (timeUp()) return stopHere(false, `Time budget reached. Re-run with ?skip=${skip} to continue.`);

      skip++; // advance resume cursor for every review we consume

      // No character filter — only skip reviews that have no text at all
      if (!review.review_text || !review.review_text.trim()) continue;

      const slug = (review.author_title + '-' + review.review_id)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (existingSlugs.has(slug)) {
        skipped++;
        continue;
      }

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

      const webflowRes = await fetch(
        `https://api.webflow.com/v2/collections/${collectionId}/items/live`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${webflowToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const webflowData = await webflowRes.json();
      if (webflowRes.ok) {
        existingSlugs.add(slug);
        pushed++;
      }
      results.push({ slug, status: webflowRes.status });
    }

    // a short page means we've reached the end of the reviews
    if (batch.length < REVIEWS_PER_PAGE) return stopHere(true, 'Reached end of reviews — backfill complete.');
  }
}