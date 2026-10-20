'use strict';

// Mirrors Java DealSearchService + DealController GET /api/deals/search and /facets.
// Filters, ORDER BY, LIMIT/OFFSET and COUNT are performed in PostgreSQL;
// image records are fetched only for the deals on the requested page.
const { query } = require('./db');
const { readClients } = require('./config');
const { mapDeal, DEAL_TYPES } = require('./models');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 24;
const SORTS = new Set([
  'random', 'newest', 'oldest', 'price_asc', 'price_desc',
  'title_asc', 'title_desc'
]);
const VALID_TYPES = new Set(DEAL_TYPES.map(t => t.toUpperCase()));

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function single(value, name) {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    throw badRequest(`Invalid ${name}`);
  }
  return value == null ? null : String(value);
}

function pageInt(value, defaultValue, name, min, max) {
  const input = single(value, name);
  if (input == null) return defaultValue;
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input))) {
    throw badRequest(`Invalid ${name}`);
  }
  const n = Number(input);
  if (n < min || n > max) {
    throw badRequest('page must be >= 0 and size must be between 1 and 100');
  }
  return n;
}

function usdValue(value, name) {
  const input = single(value, name);
  if (input == null) return null;
  const s = input.trim();
  // Match Java's BigDecimal parameter: accept plain or scientific decimal
  // strings, but disallow NaN, Infinity and any malformed values.
  if (s.length > 100 || !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(s)) {
    throw badRequest(`Invalid ${name}`);
  }
  const numericValue = Number(s);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw badRequest('Invalid USD price range');
  }
  return s;
}

// Compare valid positive decimal values exactly for range validation;
// never round USD filter bounds using JavaScript floating point.
function decimalParts(str) {
  let value = str.replace(/^\+/, '').toLowerCase();
  let exponent = 0;
  if (value.includes('e')) {
    const pieces = value.split('e');
    value = pieces[0];
    exponent = Number(pieces[1]);
  }
  const dot = value.indexOf('.');
  const decimalPlaces = dot === -1 ? 0 : value.length - dot - 1;
  let digits = value.replace('.', '').replace(/^0+/, '') || '0';
  if (digits === '0') return { digits, exponent: 0 };
  exponent -= decimalPlaces;
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  return { digits, exponent };
}

function compareUsd(a, b) {
  const left = decimalParts(a), right = decimalParts(b);
  const scaleA = left.digits.length + left.exponent;
  const scaleB = right.digits.length + right.exponent;
  if (scaleA !== scaleB) return Math.sign(scaleA - scaleB);
  const width = Math.max(left.digits.length, right.digits.length);
  return Math.sign((left.digits.padEnd(width, '0') > right.digits.padEnd(width, '0'))
    - (left.digits.padEnd(width, '0') < right.digits.padEnd(width, '0')));
}

function permittedPairs(cfg, provider, type) {
  const stores = [];
  const types = [];
  for (const [store, client] of Object.entries(cfg.clients || {})) {
    if (!client || client.enabled === false) continue;
    // Java normalizes provider to lowercase and matches configuration case-insensitively.
    if (provider && store.toLowerCase() !== provider) continue;
    for (const [dealType, typeCfg] of Object.entries(client.types || {})) {
      if (!typeCfg || typeCfg.enabled === false) continue;
      if (type && dealType.toUpperCase() !== type) continue;
      stores.push(store);
      types.push(dealType.toLowerCase());
    }
  }
  return { stores, types };
}

function likeLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function sortMetadata(sorted) {
  return { empty: !sorted, sorted, unsorted: !sorted };
}

function springPage(content, page, size, totalElements, sort) {
  const sorted = sort !== 'random';
  const sortInfo = sortMetadata(sorted);
  const totalPages = Math.ceil(totalElements / size);
  return {
    content,
    pageable: {
      pageNumber: page,
      pageSize: size,
      sort: sortInfo,
      offset: page * size,
      paged: true,
      unpaged: false
    },
    totalPages,
    totalElements,
    last: page + 1 >= totalPages,
    size,
    number: page,
    sort: sortInfo,
    numberOfElements: content.length,
    first: page === 0,
    empty: content.length === 0
  };
}

async function hydrate(rows) {
  if (!rows.length) return [];
  const { rows: images } = await query(`
    SELECT id, deal_id, image_url, original_image_url
    FROM deal_image
    WHERE deal_id = ANY($1::bigint[])
    ORDER BY id ASC
  `, [rows.map(row => row.id)]);
  const byId = new Map();
  for (const image of images) {
    const id = String(image.deal_id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({
      id: Number(image.id),
      imageUrl: image.image_url,
      originalImageUrl: image.original_image_url
    });
  }
  return rows.map(row => ({
    ...mapDeal(row, byId.get(String(row.id)) || []),
    // Jackson serializes Java's DealType enum as upper-case (e.g. ELECTRONICS).
    dealType: row.deal_type == null ? null : String(row.deal_type).toUpperCase()
  }));
}

async function searchDeals(options = {}) {
  const page = pageInt(options.page, 0, 'page', 0, 2147483647);
  const size = pageInt(options.size, DEFAULT_PAGE_SIZE, 'size', 1, MAX_PAGE_SIZE);

  const provider = single(options.provider, 'provider')?.trim().toLowerCase() || null;
  const type = single(options.type, 'type')?.trim().toUpperCase() || null;
  if (type && !VALID_TYPES.has(type)) throw badRequest(`Unknown deal type: ${options.type}`);

  const search = single(options.search, 'search')?.trim().toLowerCase() || '';
  if (search.length > 200) throw badRequest('search must be at most 200 characters');

  const country = single(options.country, 'country')?.trim().toUpperCase() || null;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw badRequest('country must be a two-letter country code');
  }

  const minPriceUsd = usdValue(options.minPriceUsd, 'minPriceUsd');
  const maxPriceUsd = usdValue(options.maxPriceUsd, 'maxPriceUsd');
  if (minPriceUsd != null && maxPriceUsd != null && compareUsd(minPriceUsd, maxPriceUsd) > 0) {
    throw badRequest('Invalid USD price range');
  }

  const rawSort = single(options.sort, 'sort');
  const sort = rawSort == null ? 'random' : rawSort.trim().toLowerCase();
  if (!SORTS.has(sort)) throw badRequest(`Unsupported sort: ${sort}`);

  // Same default Java uses: UTC date, yyyyMMdd. Random rank is md5(id + ':' + seed).
  const seed = single(options.seed, 'seed')?.trim() || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(seed)) throw badRequest('Invalid seed');

  const allowed = permittedPairs(readClients(), provider, type);
  if (!allowed.stores.length) return springPage([], page, size, 0, sort);

  const params = [allowed.stores, allowed.types];
  const predicates = [
    'd.enabled = TRUE',
    "d.status = 'ACTIVE'",
    'd.expiry_date > CURRENT_TIMESTAMP',
    `EXISTS (
      SELECT 1
      FROM unnest($1::text[], $2::text[]) AS permitted(store, type)
      WHERE permitted.store = d.store_name
        AND permitted.type = LOWER(d.deal_type::text)
    )`
  ];
  function add(value) { params.push(value); return `$${params.length}`; }

  if (country) predicates.push(`d.country = ${add(country)}`);
  if (search) {
    // Equivalent to Java's escaped, case-insensitive search over title,
    // storeName and the text of DealType enum values.
    const pattern = `%${likeLiteral(search)}%`;
    const p = add(pattern);
    predicates.push(`(
      LOWER(d.title) LIKE ${p} ESCAPE '\\'
      OR LOWER(d.store_name) LIKE ${p} ESCAPE '\\'
      OR LOWER(d.deal_type::text) LIKE ${p} ESCAPE '\\'
    )`);
  }
  if (minPriceUsd !== null || maxPriceUsd !== null || sort.startsWith('price_')) {
    predicates.push('d.price_usd IS NOT NULL');
  }
  if (minPriceUsd !== null) predicates.push(`d.price_usd >= ${add(minPriceUsd)}::numeric`);
  if (maxPriceUsd !== null) predicates.push(`d.price_usd <= ${add(maxPriceUsd)}::numeric`);

  // Identical ordering and ID tie-breakers to Java DealSearchService.
  const orderBy = {
    newest: 'd.updated_at DESC, d.id DESC',
    oldest: 'd.updated_at ASC, d.id ASC',
    price_asc: 'd.price_usd ASC, d.id DESC',
    price_desc: 'd.price_usd DESC, d.id DESC',
    title_asc: 'd.title ASC, d.id DESC',
    title_desc: 'd.title DESC, d.id DESC'
  };
  const ordering = sort === 'random'
    ? `md5(d.id::text || ':' || ${add(seed)}::text) ASC, d.id ASC`
    : orderBy[sort];

  const where = predicates.join('\n      AND ');
  const countParams = params.slice(0, sort === 'random' ? -1 : params.length);
  const { rows: counted } = await query(`
    SELECT COUNT(*)::bigint AS total
    FROM deal d
    WHERE ${where}
  `, countParams);
  const total = Number(counted[0]?.total || 0);
  if (page * size >= total) return springPage([], page, size, total, sort);

  const limit = add(size);
  const offset = add(page * size);
  const { rows } = await query(`
    SELECT d.id, d.slug, d.title, d.description, d.price,
           d.original_price, d.country, d.currency, d.price_usd,
           d.product_id, d.image_url, d.product_url, d.deal_type,
           d.store_name, d.location, d.enabled, d.expiry_date,
           d.created_at, d.updated_at, d.deal_source, d.status
    FROM deal d
    WHERE ${where}
    ORDER BY ${ordering}
    LIMIT ${limit} OFFSET ${offset}
  `, params);

  return springPage(await hydrate(rows), page, size, total, sort);
}

async function getFacets() {
  const allowed = permittedPairs(readClients(), null, null);
  if (!allowed.stores.length) return { providers: [], dealTypes: [], totalDeals: 0 };

  const { rows } = await query(`
    SELECT d.store_name, d.deal_type, COUNT(*)::bigint AS count
    FROM deal d
    WHERE d.enabled = TRUE
      AND d.status = 'ACTIVE'
      AND d.expiry_date > CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1
        FROM unnest($1::text[], $2::text[]) AS permitted(store, type)
        WHERE permitted.store = d.store_name
          AND permitted.type = LOWER(d.deal_type::text)
      )
    GROUP BY d.store_name, d.deal_type
  `, [allowed.stores, allowed.types]);

  const providers = new Map(), types = new Map();
  for (const row of rows) {
    if (!row.store_name || !row.deal_type) continue;
    const count = Number(row.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const type = String(row.deal_type).toUpperCase();
    providers.set(row.store_name, (providers.get(row.store_name) || 0) + count);
    types.set(type, (types.get(type) || 0) + count);
  }

  const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const providerList = [...providers].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || byName(a, b));
  const dealTypes = [...types].map(([name, count]) => ({ name, count }))
    .sort(byName);
  const totalDeals = providerList.reduce((acc, { count }) => acc + count, 0);
  return { providers: providerList, dealTypes, totalDeals };
}

module.exports = { searchDeals, getFacets };
