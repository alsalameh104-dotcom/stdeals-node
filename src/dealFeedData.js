'use strict';

const { readClients } = require('./config');
const { mapDeal, DEAL_TYPES } = require('./models');
const { query } = require('./db');

// Fetch only fields serialized by mapDeal; don't transfer large metadata blobs.
const DEAL_COLUMNS = `id, slug, title, description, price, original_price, country,
  currency, price_usd, product_id, image_url, product_url, deal_type,
  store_name, location, enabled, expiry_date, created_at, updated_at,
  deal_source, status`;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function allowedPairs(storeFilter = null, typeFilter = null) {
  const config = readClients();
  const stores = [], types = [];
  for (const [name, client] of Object.entries(config.clients || {})) {
    if (!client || client.enabled === false) continue;
    if (storeFilter && name.toLowerCase() !== storeFilter.toLowerCase()) continue;
    for (const [type, settings] of Object.entries(client.types || {})) {
      if (!settings || settings.enabled === false) continue;
      if (typeFilter && type.toLowerCase() !== typeFilter.toLowerCase()) continue;
      stores.push(name);
      types.push(type.toLowerCase());
    }
  }
  return { stores, types };
}

/** Missing/blank/ALL means all markets; otherwise require an ISO-style market code. */
function normalizeCountry(value) {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw badRequest('country must be a two-letter country code or ALL');
  }
  const country = String(value).trim().toUpperCase();
  if (!country || country === 'ALL') return null;
  if (!/^[A-Z]{2}$/.test(country)) {
    throw badRequest('country must be a two-letter country code or ALL');
  }
  return country;
}

/** Avoid allocating feed slots for countries not configured on enabled clients. */
function isSupportedCountry(country) {
  if (country == null) return true;
  return Object.values(readClients().clients || {}).some(client =>
    client && client.enabled !== false &&
    String(client.country || '').trim().toUpperCase() === country
  );
}

function enabledStore(requested) {
  if (requested == null) return null;
  if (typeof requested !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(requested)) return null;
  const cfg = readClients();
  for (const [store, config] of Object.entries(cfg.clients || {})) {
    if (store.toLowerCase() === requested.toLowerCase() && config && config.enabled !== false) return store;
  }
  return null;
}

function parsedType(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const type = value.trim().toLowerCase();
  if (!DEAL_TYPES.includes(type)) throw badRequest('Unknown deal type');
  return type;
}

const pairsClause = (storeArrayIndex = 1, typeArrayIndex = 2, alias = 'd') => `EXISTS (
    SELECT 1 FROM unnest($${storeArrayIndex}::text[], $${typeArrayIndex}::text[])
      AS permitted(store, type)
    WHERE permitted.store = ${alias}.store_name
      AND permitted.type = LOWER(${alias}.deal_type::text)
  )`;

async function hydrateRows(rows, runQuery = query) {
  if (!rows.length) return [];
  const imageMap = new Map();
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const ids = batch.map(row => String(row.id));
    const response = await runQuery(`
      SELECT id, deal_id, image_url, original_image_url
      FROM deal_image WHERE deal_id = ANY($1::bigint[])
      ORDER BY id ASC
    `, [ids]);
    for (const img of response.rows) {
      const id = String(img.deal_id);
      if (!imageMap.has(id)) imageMap.set(id, []);
      imageMap.get(id).push({
        id: Number(img.id),
        imageUrl: img.image_url,
        originalImageUrl: img.original_image_url
      });
    }
  }
  return rows.map(row => mapDeal(row, imageMap.get(String(row.id)) || []));
}

function feedResult(content, size, hasNext, nextCursor) {
  return { content, size, numberOfElements: content.length, hasNext, nextCursor };
}

module.exports = {
  badRequest, httpError, allowedPairs, enabledStore, parsedType,
  normalizeCountry, isSupportedCountry,
  pairsClause, hydrateRows, feedResult, DEAL_COLUMNS
};