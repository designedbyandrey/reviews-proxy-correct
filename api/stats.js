export const config = {
  maxDuration: 30,
};

// Public endpoint (no auth) so the website can fetch it from the browser.
// Edge-cached for ~2 weeks, so Outscraper is only hit about once every two weeks
// no matter how many visitors load the page. Each refresh costs 1 review record.

export default async function handler(req, res) {
  // Allow the website to call this from the browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at Vercel's edge for 14 days; serve slightly stale while refreshing
  res.setHeader('Cache-Control', 's-maxage=1209600, stale-while-revalidate=86400');

  const placeId = process.env.GOOGLE_PLACE_ID;

  try {
    const r = await fetch(
      `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(placeId)}&reviewsLimit=1&async=false`,
      { headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY } }
    );
    const d = await r.json();
    const place = d.data?.[0] || {};

    const rating = typeof place.rating === 'number' ? place.rating : null;
    const count = place.reviews ?? place.reviews_count ?? place.reviewsCount ?? null;

    return res.status(200).json({
      rating,                                            // e.g. 4.9
      reviewCount: count,                                // e.g. 124
      ratingText: rating != null ? rating.toFixed(1).replace('.', ',') : null, // "4,9"
      countText: count != null ? `${Math.floor(count / 50) * 50}+` : null,     // "100+"
    });
  } catch (e) {
    return res.status(200).json({ rating: null, reviewCount: null, ratingText: null, countText: null });
  }
}
