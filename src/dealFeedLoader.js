'use strict';

const { query } = require('./db');
const { allowedPairs, pairsClause, hydrateRows, DEAL_COLUMNS } = require('./dealFeedData');
const { randomInt } = require('node:crypto');

// Java DealFeedLoader: fetch latest IDs first, fetch images only for those IDs,
// and shuffle ONCE per ten-minute snapshot rather than for each request.
async function load(store, limit, country = null) {
  const allowed = allowedPairs(store);
  if (!allowed.stores.length) return [];

  const capped = Math.max(1, limit);
  const idsResult = await query(`
    SELECT d.id FROM deal d
    WHERE d.enabled = TRUE
      AND d.status = 'ACTIVE'
      AND d.expiry_date > NOW()
      AND ${pairsClause()}
      ${country ? 'AND d.country = $4' : ''}
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT $3
  `, country
    ? [allowed.stores, allowed.types, capped, country]
    : [allowed.stores, allowed.types, capped]);

  if (!idsResult.rows.length) return [];
  const ids = idsResult.rows.map(row => String(row.id));
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { rows } = await query(`SELECT ${DEAL_COLUMNS} FROM deal WHERE id = ANY($1::bigint[])`, [batch]);
    const hydrated = await hydrateRows(rows);
    for (const deal of hydrated) byId.set(String(deal.id), deal);
  }
  const deals = ids.map(id => byId.get(id)).filter(Boolean);
  for (let i = deals.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deals[i], deals[j]] = [deals[j], deals[i]];
  }
  return deals;
}

module.exports = { load };