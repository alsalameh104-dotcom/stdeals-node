# Java -> Node migration map

| Spring Boot | Node.js |
|---|---|
| `DealController` | `src/server.js` public deal routes |
| `AdminDealController` | `src/server.js` admin deal routes |
| `AsyncDealController` | `src/server.js` sync/config routes |
| `AuthController` + `AuthService` | `src/auth.js` |
| `DealService` + repositories | `src/deals.js` + `src/db.js` |
| `ClientsConfigService` | `src/config.js` |
| `JwtUtil` + `JwtFilter` | `src/auth.js` |
| `RateLimitFilter` | `express-rate-limit` |
| Spring cache | `src/cache.js` |
| `SitemapController` | `src/server.js` |
| `JavaMailSender` | `nodemailer` |
| Static `/images/**` | Express static middleware |
| JPA/PostgreSQL | `pg` + SQL |

## What is deliberately not translated yet

The provider/scraper layer (`FlareSolverrService`, FacebookStoryExtractor, Amazon/Noon/Walmart/eBay/BestBuy/Samsung parsers, scheduling and image downloading through FlareSolverr) stays in Java for the first migration.

This is intentional: it allows the public application server to move to Node without simultaneously rewriting the most failure-prone scraping code.

Node's `/api/admin/deals/sync` forwards the sync request to `SCRAPER_URL`.

## Recommended final layout

```text
Internet
   |
 Nginx
   |
 Node.js :8080  ---> PostgreSQL
   |
   +----> Java scraper :8081 ---> FlareSolverr
```

Only Node/Nginx should be exposed publicly. The Java scraper should listen on localhost/private networking.
