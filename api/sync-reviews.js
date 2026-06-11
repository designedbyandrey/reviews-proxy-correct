export const config = {
  maxDuration: 60,
};

const VERSION = 'v4-reliable-dedup';

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

  let skip = parseInt(req.query.skip || '0', 10);

  const timeUp = () => Date.now() - startTime > TIME_BUDGET_MS;

  function generateStars(rating) {
    const filled = Math.round(rating);
    return '★'.repeat(filled) + '☆'.repeat(5 - filled);
  }

  // Canonical lowercase slug — must match exactly what Webflow stores, or dedup fails
  function makeSlug(review) {
    return (review.author_title + '-' + review.review_id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // fetch wrapper that backs off on Webflow 429 rate limits
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

  // 1. Read existing slugs from the STAGED view (/items) — immediately consistent,
  //    unlike /items/live which lags right after a write and caused the duplicates.
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

  const stop = (done, message) =>
    res.status(200).json({ version: VERSION, done, message, nextSkip: skip, pushed, skipped, failed });

  // 2. Walk reviews in small pages; push new ones, skip ones already present
  while (true) {
    if (timeUp()) return stop(false, `Time budget reached. Re-run with ?skip=${skip} to continue.`);

    const oRes = await fetch(
      `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(placeId)}&reviewsLimit=${PAGE}&skip=${skip}&sort=newest&async=false`,
      { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY } }
    );
    const oData = await oRes.json();
    const batch = oData.data?.[0]?.reviews_data || [];
    if (!batch.length) return stop(true, 'No more reviews — complete.');

    for (const review of batch) {
      if (timeUp()) return stop(false, `Time budget reached. Re-run with ?skip=${skip} to continue.`);
      skip++;

      if (!review.review_text || !review.review_text.trim()) continue;

      const slug = makeSlug(review);
      if (existingSlugs.has(slug)) {
        skipped++;
        continue;
      }
      existingSlugs.add(slug); // guard against repeats within this same run

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
      if (wRes.ok) pushed++;
      else {
        failed++;
        existingSlugs.delete(slug); // let a failed one retry next run
      }
    }

    if (batch.length < PAGE) return stop(true, 'Reached end of reviews — complete.');
  }
}