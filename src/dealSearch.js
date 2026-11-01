'use strict';

const { pool, query } = require('./db');
const { DEAL_TYPES } = require('./models');
const { readClients } = require('./config');
const {
  badRequest, allowedPairs, pairsClause, hydrateRows, DEAL_COLUMNS,
  normalizeCountry, isSupportedCountry
} = require('./dealFeedData');

const SORTS = {
  random: null,
  relevance: null,
  newest: 'd.created_at DESC, d.id DESC',
  oldest: 'd.created_at ASC, d.id ASC',
  price_asc: 'd.price_usd ASC, d.id DESC',
  price_desc: 'd.price_usd DESC, d.id DESC',
  title_asc: 'd.title ASC, d.id DESC',
  title_desc: 'd.title DESC, d.id DESC'
};

function intParam(value, defaultValue, max, field) {
  if (value == null || value === '') return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`Invalid ${field}`);
  const input = String(value);
  if (!/^\d{1,8}$/.test(input)) throw badRequest(`Invalid ${field}`);
  const n = Number(input);
  if (!Number.isInteger(n) || n < (field === 'size' ? 1 : 0) || n > max) {
    throw badRequest(`Invalid ${field}`);
  }
  return n;
}

function decimalParam(value, field) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (raw.length > 100 || !/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?$/.test(raw)) {
    throw badRequest(`Invalid ${field}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw badRequest('Invalid USD price range');
  const significand = raw.replace(/^[+\-]/, '').split(/[eE]/)[0].replace('.', '').replace(/^0+/, '');
  if ((significand.length || 1) > 16) throw badRequest('Price has too many digits');
  return raw;
}

function prepare(args = {}) {
  const page = intParam(args.page, 0, 100, 'page');
  const size = intParam(args.size, 24, 50, 'size');
  const type = args.type ? String(args.type).trim().toLowerCase() : null;
  if (type && !DEAL_TYPES.includes(type)) throw badRequest(`Unknown deal type: ${args.type}`);

  const country = normalizeCountry(args.country);
  const minPriceUsd = decimalParam(args.minPriceUsd, 'minPriceUsd');
  const maxPriceUsd = decimalParam(args.maxPriceUsd, 'maxPriceUsd');
  if (minPriceUsd != null && maxPriceUsd != null && Number(minPriceUsd) > Number(maxPriceUsd)) {
    throw badRequest('Invalid USD price range');
  }

  const provider = args.provider == null || String(args.provider).trim() === ''
      ? null : String(args.provider).trim().toLowerCase();
  const text = args.search == null ? '' : String(args.search).trim().toLowerCase().replace(/\s+/g, ' ');
  if (text.length > 120) throw badRequest('search must be at most 120 characters');
  if (text.length === 1) throw badRequest('search must contain at least 2 characters');
  // Match each distinct word anywhere in title, retailer name or deal type.
  const terms = text ? [...new Set(text.split(' '))] : [];
  if (terms.length > 12) throw badRequest('search must contain at most 12 distinct words');

  const sortKey = args.sort == null ? 'random' : String(args.sort).trim().toLowerCase();
  if (!Object.hasOwn(SORTS, sortKey)) throw badRequest(`Unsupported sort: ${sortKey}`);
  if (sortKey === 'relevance' && !text) throw badRequest('relevance sorting requires a search term');
  const seed = args.seed == null || String(args.seed).trim() === ''
      ? new Date().toISOString().slice(0, 10).replaceAll('-', '')
      : String(args.seed).trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(seed)) throw badRequest('Invalid seed');

  let maxId = null;
  if (args.maxId != null) {
    const value = String(args.maxId);
    if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) throw badRequest('Invalid search cursor');
    maxId = value;
  }
  return { page, size, type, provider, country, minPriceUsd, maxPriceUsd, text, terms, sortKey, seed, maxId };
}

function sortMetadata(sortKey) {
  const sorted = sortKey !== 'random' && sortKey !== 'relevance';
  return { empty: !sorted, sorted, unsorted: !sorted };
}

function pageResponse(content, totalElements, opts) {
  const { size, page, sortKey } = opts;
  const totalPages = Math.ceil(totalElements / size);
  const sort = sortMetadata(sortKey);
  return {
    content,
    pageable: {
      pageNumber: page, pageSize: size, sort, offset: page * size,
      paged: true, unpaged: false
    },
    totalPages,
    totalElements,
    last: page + 1 >= totalPages,
    size,
    number: page,
    sort,
    first: page === 0,
    numberOfElements: content.length,
    empty: content.length === 0
  };
}

// Match literal text, not SQL wildcard patterns supplied by a visitor.
function escapeLike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const TITLE_LOWER = "LOWER(COALESCE(d.title, ''))";
const STORE_LOWER = "LOWER(COALESCE(d.store_name, ''))";

function filters(opts) {
  const allowed = allowedPairs(opts.provider, opts.type);
  const params = [allowed.stores, allowed.types];
  const clauses = [
    'd.enabled = TRUE',
    "d.status = 'ACTIVE'",
    'd.expiry_date > NOW()',
    pairsClause()
  ];
  const add = value => { params.push(value); return `$${params.length}`; };
  if (opts.country) clauses.push(`d.country = ${add(opts.country)}`);
  if (opts.maxId != null) clauses.push(`d.id <= ${add(opts.maxId)}::bigint`);
  // Every query word must match, but words can appear in any order.
  // The existing provider/type filters, country, and pagination remain unchanged.
  const titleConditions = [];
  for (const term of opts.terms) {
    const pattern = add(`%${escapeLike(term)}%`);
    const titleMatch = `${TITLE_LOWER} LIKE ${pattern} ESCAPE '\\'`;
    const storeMatch = `${STORE_LOWER} LIKE ${pattern} ESCAPE '\\'`;
    titleConditions.push(titleMatch);
    const alternatives = [titleMatch, storeMatch];
    const matchingTypes = DEAL_TYPES.filter(t => t.includes(term));
    if (matchingTypes.length) {
      alternatives.push(`LOWER(d.deal_type::text) = ANY(${add(matchingTypes)}::text[])`);
    }
    clauses.push(`(${alternatives.join(' OR ')})`);
  }
  if (opts.minPriceUsd != null || opts.maxPriceUsd != null || opts.sortKey.startsWith('price_')) {
    clauses.push('d.price_usd IS NOT NULL');
  }
  if (opts.minPriceUsd != null) clauses.push(`d.price_usd >= ${add(opts.minPriceUsd)}::numeric`);
  if (opts.maxPriceUsd != null) clauses.push(`d.price_usd <= ${add(opts.maxPriceUsd)}::numeric`);
  return { where: clauses.join(' AND '), params, allowed, titleConditions };
}

// Same relevance buckets as Java: exact title, prefix, phrase, all title words,
// partial title word matches, then matches only in retailer name or deal type.
function relevanceOrder(opts, values, titleConditions) {
  const add = value => { values.push(value); return `$${values.length}`; };
  const exact = add(opts.text);
  const prefix = add(`${escapeLike(opts.text)}%`);
  const phrase = add(`%${escapeLike(opts.text)}%`);
  const allTitle = titleConditions.map(t => `(${t})`).join(' AND ');
  const someTitle = titleConditions.map(t => `(${t})`).join(' OR ');
  return `CASE
    WHEN ${TITLE_LOWER} = ${exact} THEN 0
    WHEN ${TITLE_LOWER} LIKE ${prefix} ESCAPE '\\' THEN 1
    WHEN ${TITLE_LOWER} LIKE ${phrase} ESCAPE '\\' THEN 2
    WHEN (${allTitle}) THEN 3
    WHEN (${someTitle}) THEN 4
    ELSE 5
  END ASC, d.updated_at DESC, d.id DESC`;
}

/** Mirrors Java DealSearchService.getActivePageableDeals. */
async function searchDeals(args = {}) {
  const opts = prepare(args);
  const { where, params, allowed, titleConditions } = filters(opts);
  if (!allowed.stores.length) return pageResponse([], 0, opts);

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '8000ms'");
    const totalResult = await client.query(`SELECT COUNT(*) AS total FROM deal d WHERE ${where}`, params);
    const total = Number(totalResult.rows[0].total);
    let rows = [];
    if (total) {
      const values = [...params];
      let sortSql;
      if (opts.sortKey === 'random') {
        const seedPos = values.length + 1;
        values.push(opts.seed);
        sortSql = `md5(d.id::text || ':' || $${seedPos}::text) ASC, d.id ASC`;
      } else if (opts.sortKey === 'relevance') {
        sortSql = relevanceOrder(opts, values, titleConditions);
      } else {
        sortSql = SORTS[opts.sortKey];
      }
      values.push(opts.size, opts.page * opts.size);
      const limitPos = values.length - 1;
      const offsetPos = values.length;
      const result = await client.query(`
        SELECT ${DEAL_COLUMNS.split(',').map(x => 'd.' + x.trim()).join(', ')} FROM deal d
        WHERE ${where}
        ORDER BY ${sortSql}
          LIMIT $${limitPos} OFFSET $${offsetPos}
      `, values);
      rows = await hydrateRows(result.rows, (sql, v) => client.query(sql, v));
    }
    await client.query('COMMIT');
    return pageResponse(rows, total, opts);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Mirrors Java DealSearchService.getPublicDealFacets. */
async function getPublicDealFacets(country = null) {
  const market = normalizeCountry(country);
  const { stores, types } = allowedPairs();
  if (!stores.length || !isSupportedCountry(market)) {
    return { providers: [], dealTypes: [], dealTypesByStore: {}, totalDeals: 0 };
  }
  const params = [stores, types];
  const countryCondition = market ? 'AND d.country = $3' : '';
  if (market) params.push(market);
  const response = await query(`
    SELECT d.store_name AS store_name, LOWER(d.deal_type::text) AS deal_type,
           COUNT(*) AS count
    FROM deal d
    WHERE d.enabled = TRUE
      AND d.status = 'ACTIVE'
      AND d.expiry_date > NOW()
      AND ${pairsClause()}
      ${countryCondition}
    GROUP BY d.store_name, LOWER(d.deal_type::text)
  `, params);
  const providers = new Map(), dealTypes = new Map(), typesByStore = new Map();
  for (const row of response.rows) {
    const count = Number(row.count);
    if (!row.store_name || !row.deal_type || count <= 0) continue;
    providers.set(row.store_name, (providers.get(row.store_name) || 0) + count);
    const upper = String(row.deal_type).toUpperCase();
    dealTypes.set(upper, (dealTypes.get(upper) || 0) + count);
    if (!typesByStore.has(row.store_name)) typesByStore.set(row.store_name, new Map());
    const storeTypes = typesByStore.get(row.store_name);
    storeTypes.set(upper, (storeTypes.get(upper) || 0) + count);
  }
  const sortedProviders = [...providers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  const sortedTypes = [...dealTypes].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  // The per-store categories come from the same aggregation query: no extra DB call.
  const dealTypesByStore = Object.fromEntries([...typesByStore.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([store, categories]) => [store, [...categories.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count }))]));
  const totalDeals = [...providers.values()].reduce((sum, count) => sum + count, 0);
  return { providers: sortedProviders, dealTypes: sortedTypes, dealTypesByStore, totalDeals };
}

/** Active market counts; only deals matching the enabled store's configured market. */
async function getPublicCountries() {
  const { stores, types } = allowedPairs();
  if (!stores.length) return { countries: [], totalDeals: 0 };

  const clients = readClients().clients || {};
  const { rows } = await query(`
    SELECT d.country, d.store_name, LOWER(d.deal_type::text) AS deal_type,
           COUNT(*)::bigint AS count
    FROM deal d
    WHERE d.enabled = TRUE
      AND d.status = 'ACTIVE'
      AND d.expiry_date > NOW()
      AND d.country IS NOT NULL
      AND ${pairsClause()}
    GROUP BY d.country, d.store_name, LOWER(d.deal_type::text)
  `, [stores, types]);

  const counts = new Map();
  for (const row of rows) {
    const country = String(row.country || '').trim().toUpperCase();
    const client = clients[row.store_name];
    const count = Number(row.count);
    if (!/^[A-Z]{2}$/.test(country) || !client || client.enabled === false ||
        String(client.country || '').trim().toUpperCase() !== country ||
        !row.deal_type || !Number.isFinite(count) || count <= 0) continue;
    counts.set(country, (counts.get(country) || 0) + count);
  }
  const countries = [...counts].map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code));
  const totalDeals = countries.reduce((sum, entry) => sum + entry.count, 0);
  return { countries, totalDeals };
}

module.exports = { searchDeals, getPublicDealFacets, getPublicCountries, prepare, pageResponse };