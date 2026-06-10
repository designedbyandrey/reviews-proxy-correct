export const config = {
  maxDuration: 60, // raise to 300 if you're on Vercel Pro and have a large collection
};

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const placeId = process.env.GOOGLE_PLACE_ID;
  const webflowToken = process.env.WEBFLOW_API_TOKEN;
  const collectionId = process.env.WEBFLOW_COLLECTION_ID;

  const startTime = Date.now();
  const TIME_BUDGET_MS = 50000;   // stop before the 60s hard limit and report progress
  const REVIEWS_PER_FETCH = 500;  // Outscraper max per request; paginates past this with skip

  function generateStars(rating) {
    const filled = Math.round(rating);
    const empty = 5 - filled;
    return '★'.repeat(filled) + '☆'.repeat(empty);
  }

  // 1. Fetch ALL reviews from Outscraper (pages with skip until exhausted)
  const allReviews = [];
  let skip = 0;
  while (true) {
    const outscraperRes = await fetch(
      `https://api.app.outscraper.com/maps/reviews-v3?query=${placeId}&reviewsLimit=${REVIEWS_PER_FETCH}&skip=${skip}&async=false`,
      { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY } }
    );
    const outscraperData = await outscraperRes.json();
    const batch = outscraperData.data?.[0]?.reviews_data || [];
    allReviews.push(...batch);

    if (batch.length < REVIEWS_PER_FETCH) break; // last page
    skip += REVIEWS_PER_FETCH;
    if (Date.now() - startTime > TIME_BUDGET_MS) break; // safety
  }

  if (!allReviews.length) {
    return res.status(200).json({ message: 'No reviews returned from Outscraper' });
  }

  // 2. No length filter — keep every review that actually has text
  const reviews = allReviews.filter(r => r.review_text && r.review_text.trim().length > 0);

  // 3. Fetch ALL existing slugs (paginate so dedup is correct past 100 items)
  const existingSlugs = new Set();
  let wfOffset = 0;
  while (true) {
    const existingRes = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items/live?limit=100&offset=${wfOffset}`,
      { headers: { Authorization: `Bearer ${webflowToken}` } }
    );
    const existingData = await existingRes.json();
    const items = existingData.items || [];
    items.forEach(i => existingSlugs.add(i.fieldData.slug));
    if (items.length < 100) break;
    wfOffset += 100;
  }

  // 4. Push each new review (time guard lets a big backfill resume safely on re-run)
  const results = [];
  let pushed = 0;
  let skipped = 0;

  for (const review of reviews) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      return res.status(200).json({
        done: false,
        message: 'Time budget reached — re-run to continue. Created reviews are skipped automatically.',
        totalFetched: reviews.length,
        pushed,
        skipped,
        results,
      });
    }

    const slug = review.author_title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + review.review_id;
    if (existingSlugs.has(slug)) {
      skipped++;
      results.push({ slug, status: 'skipped' });
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
        headers: {
          Authorization: `Bearer ${webflowToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
    const webflowData = await webflowRes.json();

    if (webflowRes.ok) {
      existingSlugs.add(slug);
      pushed++;
    }
    results.push({ slug, status: webflowRes.status, response: webflowData });
  }

  res.status(200).json({ done: true, totalFetched: reviews.length, pushed, skipped, results });
}