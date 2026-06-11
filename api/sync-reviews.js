export const config = {
  maxDuration: 60,
};

const VERSION = 'v5-credit-safe';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const placeId = process.env.GOOGLE_PLACE_ID;
  const webflowToken = process.env.WEBFLOW_API_TOKEN;
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;

  const startTime = Date.now();
  const TIME_BUDGET_MS = 50000;
  const PAGE = 30;

  // HARD safety ceiling on how many reviews we'll ever fetch. Protects credits.
  // Default 400 covers this client's ~122 with margin. Override per call with ?maxSkip=.
  const HARD_CAP = parseInt(req.query.maxSkip || '400', 10);

  let skip = parseInt(req.query.skip || '0', 10);
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

  // Read existing slugs from the staged view (immediately consistent)
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

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let totalReviews = null;

  const stop = (done, message) =>
    res.status(200).json({ version: VERSION, done, message, nextSkip: skip, totalReviews, pushed, skipped, failed });

  while (true) {
    if (timeUp()) return stop(false, `Time budget reached. Re-run with ?skip=${skip} to continue.`);

    // STOP #1 — absolute safety cap on reviews fetched
    if (skip >= HARD_CAP) {
      return stop(true, `Safety cap of ${HARD_CAP} reviews reached — stopping to protect credits. If this place genuinely has more, re-run with a higher ?maxSkip= value.`);
    }

    const oRes = await fetch(
      `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(placeId)}&reviewsLimit=${PAGE}&skip=${skip}&sort=newest&async=false`,
      { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY } }
    );
    const oData = await oRes.json();
    const place = oData.data?.[0] || {};
    const batch = place.reviews_data || [];

    // Capture the place's own total-review count if Outscraper provides one
    const reported = place.reviews ?? place.reviews_count ?? place.reviewsCount;
    if (typeof reported === 'number') totalReviews = reported;

    // STOP #2 — empty page
    if (!batch.length) return stop(true, 'No more reviews — complete.');

    let newInPage = 0;
    let presentInPage = 0;

    for (const review of batch) {
      if (timeUp()) return stop(false, `Time budget reached. Re-run with ?skip=${skip} to continue.`);
      skip++;

      if (!review.review_text || !review.review_text.trim()) continue;

      const slug = makeSlug(review);
      if (existingSlugs.has(slug)) {
        skipped++;
        presentInPage++;
        continue;
      }
      existingSlugs.add(slug);

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
      if (wRes.ok) { pushed++; newInPage++; }
      else { failed++; existingSlugs.delete(slug); }
    }

    // STOP #3 — we've reached the place's reported total
    if (totalReviews != null && skip >= totalReviews) {
      return stop(true, `Reached the place's reported total of ${totalReviews} reviews — complete.`);
    }

    // STOP #4 — a full page with nothing new and everything already imported
    // (means Outscraper is repeating reviews we already have = past the end)
    if (newInPage === 0 && presentInPage > 0) {
      return stop(true, 'Reached reviews already imported — complete.');
    }

    // STOP #5 — short page
    if (batch.length < PAGE) return stop(true, 'Reached end of reviews — complete.');
  }
}