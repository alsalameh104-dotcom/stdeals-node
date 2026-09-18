-- Run this against the existing STDeals PostgreSQL database before switching traffic.
-- The Node migration expects the same Hibernate-generated tables/columns.

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('deal', 'deal_image', 'users')
ORDER BY table_name;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'deal'
ORDER BY ordinal_position;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'deal_image'
ORDER BY ordinal_position;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
ORDER BY ordinal_position;
