# STDeals Node.js — Java cached-feed parity patch

Contains ONLY modified/new Node.js files. Preserve all other project files.

## Changed existing files
- `server.js`: Java-compatible public routes, stricter PostgreSQL-search rate limit, cache invalidation on admin mutations; existing admin/auth/product-price routes preserved.
- `config.js`: `DEALS_FEED_*` environment configuration mirroring the Java `deals.feed` settings.
- `dealPagination.js`: backward-compatible require wrapper for new cached-feed implementation.

## New files
- `cachedDealFeed.js`: 10-minute independent homepage/store snapshots, single-flight refresh, Java F/S cursor format, previous-snapshot continuity.
- `dealFeedLoader.js`: load newest eligible deals once per refresh, then shuffle once.
- `dealFeedData.js`: shared enabled store/type filtering, deal hydration, and error utilities.
- `dealSearch.js`: Java-compatible advanced PostgreSQL search, limits, seed sorting, and provider/type facets.

## Copy
Copy the seven `.js` files into the directory containing your existing `server.js` and `db.js`. Do not delete `deals.js`, `db.js`, `models.js`, `cache.js`, `auth.js`, `productPrices.js` or `config/clients.yml`.

## Optional .env variables (defaults match the Java patch)

```
DEALS_FEED_HOME_LIMIT=5000
DEALS_FEED_STORE_LIMIT=2000
DEALS_FEED_TTL_SECONDS=600
DEALS_FEED_PREVIOUS_RETENTION_SECONDS=1200
DEALS_FEED_MAX_STORE_CACHES=16
```

The new Node routes DO NOT require these variables to be set: the above defaults are built in. Reduce `DB_POOL_SIZE` if your VPS cannot support 20 PostgreSQL connections per process.

## API contract

- `GET /api/deals/page?size=30` — cached homepage feed.
- `GET /api/deals/store/amazon/page?size=30` — cached Amazon feed.
- `GET /api/deals/page?type=topdeals&size=30` — cached type filter.
- `GET /api/deals/page?search=samsung&size=30` — database search with a cursor response.
- `GET /api/deals/search?search=samsung&page=0&size=30` — advanced database search with Spring Page-compatible shape.
- `GET /api/deals/facets` — enabled provider/type counts.
- `GET /api/deals` and `/api/deals/store/amazon` — legacy list response from the same cache as Java.

`/page` returns `{content,size,numberOfElements,hasNext,nextCursor}`. A feed cursor from a snapshot that is no longer retained yields HTTP 410; React should restart the feed.

Advanced search enforces max `size=50`, max `page=100`, 120-character search, at least two non-whitespace search characters, valid sort, country, and price limits. A PostgreSQL read-only transaction sets an 8-second statement timeout. Server uses existing general deal limiter (100/min/IP) and a stricter search limiter (30/min/IP) for `/search` and `/page?search=...`.

Java and Node have the same routes, response fields, filtering, seeded ordering, and F/S cursor encoding. **They maintain separate in-memory snapshots, so an F cursor started on Java cannot be resumed against Node or vice versa.** Search cursors do not depend on cached snapshots. Do not load-balance successive feed pages across Java and Node without sticky routing or a shared snapshot store.

The full-body `Deal` JSON fields are mapped by the pre-existing Node `models.js`, with the same casing already used by the frontend.

## Important
- Java remains the reference implementation; Node's Spring Page JSON representation is emulated for the commonly used page fields, not byte-identical for every possible Spring serialization version.
- Sync intentionally does not invalidate Node caches. TTL refresh remains independent. Node admin mutations do invalidate Node caches (as Java admin mutations do).
- Legacy `sitemap.xml` route is untouched. Production sitemap continues to be served from your pre-generated Nginx files.
- The seven new/modified files passed Node syntax checks, and isolated mocked-database tests passed, including single-flight, prior cursor, filters, search and invalid requests. **A real Node/PostgreSQL integration run is still required.**

## First-run smoke checks

```
node --check server.js
node --check dealSearch.js
node --check cachedDealFeed.js

curl -s 'http://127.0.0.1:8080/api/deals/page?size=30' | jq '{size, count:(.content|length), hasNext, nextCursor}'
curl -s 'http://127.0.0.1:8080/api/deals/store/amazon/page?size=30' | jq '{count:(.content|length), stores:[.content[].storeName]|unique}'
curl -s 'http://127.0.0.1:8080/api/deals/search?search=samsung&size=30' | jq '{totalElements, totalPages, size, number}'
curl -s 'http://127.0.0.1:8080/api/deals/facets' | jq '{providers:(.providers|length), totalDeals}'
```

The curl examples assume Node binds to port 8080. Adjust port if Java already uses 8080.
