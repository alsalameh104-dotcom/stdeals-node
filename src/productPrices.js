const { query } = require('./db');
const { mapDeal } = require('./models');

/**
 * Equivalent to Java PriceComparisonService.getComparablePrices(productId).
 * The USD amount is already stored in PostgreSQL; no conversion takes place here.
 */
async function getComparablePrices(productId) {
  const { rows } = await query(`
    SELECT
      d.id, d.slug, d.title, d.description,
      d.price, d.original_price, d.country, d.currency, d.price_usd,
      d.image_url, d.product_url, d.deal_type,
      d.store_name, d.location, d.enabled, d.expiry_date,
      d.created_at, d.updated_at, d.deal_source, d.status, d.product_id
    FROM deal d
    WHERE d.product_id = $1
      AND d.enabled = TRUE
      AND d.status = 'ACTIVE'
      AND d.price_usd IS NOT NULL
    ORDER BY d.price_usd ASC, d.id ASC
  `, [productId]);

  if (!rows.length) return [];

  // Load all images in one query, as the existing deals.js hydrate() does.
  const { rows: imageRows } = await query(`
    SELECT id, deal_id, image_url, original_image_url
    FROM deal_image
    WHERE deal_id = ANY($1::bigint[])
    ORDER BY id ASC
  `, [rows.map(row => row.id)]);

  const imagesByDeal = new Map();
  for (const image of imageRows) {
    const dealId = String(image.deal_id);
    if (!imagesByDeal.has(dealId)) imagesByDeal.set(dealId, []);
    imagesByDeal.get(dealId).push({
      id: Number(image.id),
      imageUrl: image.image_url,
      originalImageUrl: image.original_image_url
    });
  }

  return rows.map(row => {
    // PostgreSQL NUMERIC is returned as a string by pg. Java serializes
    // BigDecimal as a JSON number, so use a number for frontend compatibility.
    const priceUsd = Number(row.price_usd);
    const deal = {
      ...mapDeal(row, imagesByDeal.get(String(row.id)) || []),
      country: row.country,
      priceUsd,
      dealSource: row.deal_source,
      productId: Number(row.product_id)
    };

    return { deal, priceUsd };
  });
}

module.exports = { getComparablePrices };
