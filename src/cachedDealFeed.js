'use strict';

const crypto = require('node:crypto');
const { load } = require('./dealFeedLoader');
const { searchDeals } = require('./dealSearch');
const {
  badRequest, httpError, enabledStore, parsedType, feedResult
} = require('./dealFeedData');
const { config } = require('./config');
const { query } = require('./db');

const HOME = '__home__';
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 100;
const feedConfig = config.deals.feed;
const slots = new Map(); // Access-ordered LRU, at most 1 homepage + 16 stores.

const ttlMs = () => Math.max(30, feedConfig.ttlSeconds) * 1000;
const retentionMs = () => Math.max(60, feedConfig.previousRetentionSeconds) * 1000;

function slot(store) {
  const key = store == null ? HOME : store;
  if (slots.has(key)) {
    const existing = slots.get(key);
    slots.delete(key);
    slots.set(key, existing);
    return existing;
  }
  const maximum = 1 + Math.max(1, Math.min(feedConfig.maxStoreCaches, 20));
  while (slots.size >= maximum) {
    const oldestStore = [...slots.keys()].find(k => k !== HOME) || HOME;
    slots.delete(oldestStore);
  }
  const next = { current: null, previous: null, refreshAfter: 0, pending: null };
  slots.set(key, next);
  return next;
}

// Promise-based single-flight: simultaneous cache misses share exactly one load.
async function currentSnapshot(entry, store) {
  let now = Date.now();
  if (entry.current && now < entry.refreshAfter) return entry.current;
  if (entry.pending) return entry.pending;
  entry.pending = (async () => {
    now = Date.now();
    if (entry.current && now < entry.refreshAfter) return entry.current;
    const prior = entry.current;
    try {
      const maxDeals = Math.max(
          1,
          store == null
              ? feedConfig.homeLimit
              : feedConfig.storeLimit
      );
      const deals = await load(store, maxDeals);
      const fresh = {
        id: crypto.randomUUID().replaceAll('-', ''),
        deals,
        createdAt: now
      };
      entry.previous = prior;
      entry.current = fresh;
      entry.refreshAfter = Date.now() + ttlMs();
      console.info(`Refreshed public deal feed: store=${store == null ? HOME : store}, deals=${deals.length}`);
      return fresh;
    } catch (error) {
      if (prior && now < prior.createdAt + 30 * 60 * 1000) {
        entry.refreshAfter = Date.now() + 30_000;
        console.warn(`Feed refresh failed; serving temporarily stale snapshot for store=${store}`, error);
        return prior;
      }
      throw error;
    }
  })();
  try {
    return await entry.pending;
  } finally {
    entry.pending = null;
  }
}

function matchingSnapshot(entry, version) {
  const now = Date.now();
  if (entry.current && entry.current.id === version &&
      now < entry.current.createdAt + ttlMs() + retentionMs()) return entry.current;
  if (entry.previous && entry.previous.id === version &&
      now < entry.previous.createdAt + 2 * ttlMs() + retentionMs()) return entry.previous;
  return null;
}

function fingerprint(store, type, search) {
  return crypto.createHash('sha256')
    .update([store || '', type ? type.toUpperCase() : '', search.toLowerCase()].join('|'), 'utf8')
    .digest('hex').slice(0, 16);
}

function encode(parts) {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

function decode(token, expectedMode, expectedParts, fingerprintValue) {
  if (typeof token !== 'string' || token.length > 256 || token.length === 0 || !/^[\w-]+={0,2}$/.test(token)) {
    throw badRequest('Invalid or mismatched cursor');
  }
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const parts = decoded.split('|');
  if (parts.length !== expectedParts || parts[0] !== expectedMode ||
      parts[parts.length - 1] !== fingerprintValue || encode(parts) !== token.replace(/=+$/, '')) {
    throw badRequest('Invalid or mismatched cursor');
  }
  return parts;
}

function boundedNumber(input, maximum, field) {
  if (typeof input !== 'string' || !/^\d{1,8}$/.test(input)) throw badRequest(`Invalid ${field}`);
  const n = Number(input);
  if (n > maximum) throw badRequest(`Invalid ${field}`);
  return n;
}

async function searchPage(store, type, text, cursor, size, filters) {
  let page = 0;
  let seed, maxId;
  if (!cursor) {
    seed = crypto.randomBytes(12).toString('hex');
    const result = await query('SELECT MAX(id) AS newest FROM deal');
    maxId = String(result.rows[0]?.newest ?? '0');
  } else {
    const parts = decode(cursor, 'S', 5, filters);
    if (!/^[a-f0-9]{24}$/.test(parts[1]) || !/^\d{1,19}$/.test(parts[2]) ||
        BigInt(parts[2]) > 9223372036854775807n) {
      throw badRequest('Invalid search cursor');
    }
    seed = parts[1];
    maxId = parts[2];
    page = boundedNumber(parts[3], MAX_SEARCH_PAGES, 'page');
  }
  const result = await searchDeals({
    provider: store,
    type,
    search: text,
    sort: 'random',
    seed,
    maxId,
    size,
    page
  });
  const hasNext = !result.last && page < MAX_SEARCH_PAGES;
  const next = hasNext ? encode(['S', seed, maxId, String(page + 1), filters]) : null;
  return feedResult(result.content, size, hasNext, next);
}

/** Java CachedDealFeedService.getPage equivalent. */
async function getPage({ store, type, search, cursor, size = 30 } = {}) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    throw badRequest(`size must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const canonicalStore = enabledStore(store);
  if (store != null && canonicalStore == null) return feedResult([], n, false, null);
  const dealType = parsedType(type);
  const text = search == null ? '' : String(search).trim();
  if (text.length > 120) throw badRequest('Search is too long');
  if (text.length === 1) throw badRequest('Search must contain at least 2 characters');
  const filters = fingerprint(canonicalStore, dealType, text.toLowerCase());
  if (text) return searchPage(canonicalStore, dealType, text, cursor, n, filters);

  const entry = slot(canonicalStore);
  let snapshot, offset = 0;
  if (!cursor) {
    snapshot = await currentSnapshot(entry, canonicalStore);
  } else {
    const parts = decode(cursor, 'F', 4, filters);
    if (!/^[a-f0-9]{32}$/.test(parts[1])) throw badRequest('Invalid cursor');
    offset = boundedNumber(parts[2], Math.max(feedConfig.homeLimit, feedConfig.storeLimit), 'offset');
    snapshot = matchingSnapshot(entry, parts[1]);
    if (!snapshot) throw httpError(410, 'Browsing snapshot expired; restart from the first page');
  }

  const selected = dealType == null
    ? snapshot.deals
    : snapshot.deals.filter(deal => deal.dealType?.toLowerCase() === dealType);
  const start = Math.min(offset, selected.length);
  const end = Math.min(start + n, selected.length);
  const hasNext = end < selected.length;
  return feedResult(selected.slice(start, end), n, hasNext,
    hasNext ? encode(['F', snapshot.id, String(end), filters]) : null);
}

async function getAll(storeName = null) {
  const store = enabledStore(storeName);
  if (storeName != null && store == null) return [];
  return (await currentSnapshot(slot(store), store)).deals;
}

// Available for optional manual invalidation; deliberately NOT connected to sync.
function invalidate() {
  for (const entry of slots.values()) entry.refreshAfter = 0;
}

module.exports = { getPage, getAll, invalidate };
