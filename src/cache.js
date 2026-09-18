class TTLCache {
  constructor() { this.map = new Map(); }
  get(key) {
    const item = this.map.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) { this.map.delete(key); return undefined; }
    return item.value;
  }
  set(key, value, ttlMs) { this.map.set(key, { value, expiresAt: Date.now() + ttlMs }); return value; }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
module.exports = new TTLCache();
