# STDeals Node.js migration

This is the first migration stage of the Spring Boot STDeals backend.

## Architecture

- **Node.js/Express** owns the public API, authentication, PostgreSQL reads/writes, YAML client configuration, sitemap/robots, contact mail, rate limiting, compression, image serving, and optional React static hosting.
- **Java scraper** remains separate. Set `SCRAPER_URL` to the private port where the existing Java scraper runs. The Node sync endpoint forwards `/api/admin/deals/sync` to it.
- **PostgreSQL stays unchanged**. The code uses the existing Hibernate table names (`deal`, `deal_image`, `users`) so migration does not require moving data to MongoDB.

## Run

```bash
cp .env.example .env
npm install
npm start
```

For development:

```bash
npm run dev
```

## Important

1. Put the real `JWT_SECRET`, database URL, SMTP credentials, and CORS origin in `.env`.
2. Do not copy the old Java `application.yml` secrets into production. Rotate credentials that were exposed there.
3. Keep the Java scraper on a private port such as `127.0.0.1:8081`; only Nginx/Node should be public.
4. Copy your existing React production build into `public/` and Node will serve it.
5. Keep `config/clients.yml` as the same source of provider/type limits used by the Java code.

## API compatibility

The migration preserves the main existing routes:

- `GET /api/deals`
- `GET /api/deals/:id`
- `GET /api/deals/store/:storeName`
- `GET /api/common/providers`
- `GET /api/common/deal-types`
- `POST /auth/login`
- `POST /auth/register`
- `/api/admin/deals/**`
- `/api/contact`
- `/sitemap.xml`
- `/robots.txt`

The scraper implementation is intentionally not translated in this stage because FlareSolverr/browser automation and the provider parsers are the most fragile/expensive part of the project. Keeping them in Java lets the Node migration happen without changing scraping behavior.
