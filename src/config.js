const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const env = (key, fallback) => process.env[key] ?? fallback;

const config = {
  root,
  port: Number(env('PORT', 8080)),
  databaseUrl: env('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/stdeals'),
  dbSsl: env('DB_SSL', 'false') === 'true',
  jwtSecret: env('JWT_SECRET', 'change-me'),
  jwtExpirationMs: Number(env('JWT_EXPIRATION_MS', 86400000)),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean),
  baseUrl: env('BASE_URL', 'http://localhost:5173').replace(/\/$/, ''),
  clientsFile: path.resolve(root, env('CLIENTS_FILE', './config/clients.yml')),
  imageRoot: path.resolve(root, env('IMAGE_ROOT', './storage/images')),
  imagePublicUrl: env('IMAGE_PUBLIC_URL', '/images'),
  scraperUrl: env('SCRAPER_URL', ''),
  scraperTimeoutMs: Number(env('SCRAPER_TIMEOUT_MS', 10000)),
  mail: {
    host: env('MAIL_HOST', ''),
    port: Number(env('MAIL_PORT', 587)),
    user: env('MAIL_USER', ''),
    password: env('MAIL_PASSWORD', ''),
    from: env('MAIL_FROM', env('MAIL_USER', ''))
  },
  deals: {
    queryLimit: Number(env('DEALS_QUERY_LIMIT', 5000))
  },
  internalApiKey:  env('INTERNAL_API_KEY', 'change-me')
};

function readClients() {
  const text = fs.readFileSync(config.clientsFile, 'utf8');
  const parsed = YAML.parse(text) || {};
  validateClients(parsed);
  return parsed;
}

function validateClients(value) {
  if (!value.clients || typeof value.clients !== 'object' || !Object.keys(value.clients).length) {
    throw new Error('Clients configuration cannot be empty');
  }
  for (const [clientName, client] of Object.entries(value.clients)) {
    if (client.enabled && Number(client.weight ?? 1) <= 0) {
      throw new Error(`Client '${clientName}' must have weight greater than zero`);
    }
    for (const [type, typeConfig] of Object.entries(client.types || {})) {
      if (typeConfig.enabled && Number(typeConfig.weight ?? 1) <= 0) {
        throw new Error(`Client '${clientName}' type '${type}' must have weight greater than zero`);
      }
    }
  }
}

function writeClients(value) {
  validateClients(value);
  const text = YAML.stringify(value);
  fs.writeFileSync(config.clientsFile, text, 'utf8');
  return text;
}

module.exports = { config, readClients, writeClients, validateClients };
