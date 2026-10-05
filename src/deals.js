const { query, transaction } = require('./db');
const cache = require('./cache');
const { mapDeal } = require('./models');
const { readClients } = require('./config');

const DEAL_SELECT = `
  SELECT id, slug, title, description, price, original_price, currency, image_url,
         product_url, deal_type, store_name, location, enabled, expiry_date,
         created_at, updated_at, source_url, deal_source, status
  FROM deal`;

async function getImages(ids) {
  if (!ids.length) return new Map();
  const r = await query('SELECT id, deal_id, image_url, original_image_url FROM deal_image WHERE deal_id = ANY($1::bigint[])', [ids]);
  const m = new Map();
  for (const row of r.rows) {
    if (!m.has(String(row.deal_id))) m.set(String(row.deal_id), []);
    m.get(String(row.deal_id)).push({ id: Number(row.id), imageUrl: row.image_url, originalImageUrl: row.original_image_url });
  }
  return m;
}
async function hydrate(rows) {
  const imageMap = await getImages(rows.map(r => r.id));
  return rows.map(r => mapDeal(r, imageMap.get(String(r.id)) || []));
}
function enabledStores(cfg) {
  return Object.entries(cfg.clients || {})
      .filter(([, c]) => c.enabled !== false)
      .map(([name]) => name);
}
function applyLimits(deals, cfg) {
  const result = [];
  const byStore = new Map();
  for (const d of deals) { if (!byStore.has(d.storeName)) byStore.set(d.storeName, []); byStore.get(d.storeName).push(d); }
  for (const [store, storeDeals] of byStore) {
    const cc = cfg.clients?.[store];
    if (!cc?.enabled) continue;
    const byType = new Map();
    for (const d of storeDeals) { if (!byType.has(d.dealType)) byType.set(d.dealType, []); byType.get(d.dealType).push(d); }
    const clientDeals = [];
    for (const [type, typeDeals] of byType) {
      const tc = cc.types?.[type];
      if (!tc?.enabled) continue;
      const maxView = Number(tc.maxView ?? tc.maxFetch ?? 10);
      const manualPct = Number(tc.manualPercentage ?? 0);
      const auto = typeDeals.filter(d => d.dealSource === 'AUTO').sort(sortUpdated);
      const manual = typeDeals.filter(d => d.dealSource === 'MANUAL').sort(sortUpdated);
      const manualCount = Math.floor(maxView * manualPct / 100);
      const autoCount = maxView - manualCount;
      const selected = [...auto.slice(0, autoCount), ...manual.slice(0, manualCount)];
      if (selected.length < maxView) selected.push(...auto.slice(autoCount, autoCount + maxView - selected.length));
      if (selected.length < maxView) selected.push(...manual.slice(manualCount, manualCount + maxView - selected.length));
      clientDeals.push(...selected.slice(0, maxView));
    }
    clientDeals.sort(sortUpdated);
    result.push(...clientDeals.slice(0, Number(cc.maxView ?? cc.maxFetch ?? clientDeals.length)));
  }
  return result;
}
function sortUpdated(a,b) { return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0); }
async function activeDeals({ store } = {}) {
  const key = `active:${store || '*'}`;
  const cached = cache.get(key); if (cached) return cached;
  const cfg = readClients();
  const stores = enabledStores(cfg);
  const limit = Number(5000);
  if (store && !stores.includes(store)) return [];
  const params = [stores];
  let where = `WHERE enabled = true AND status = 'ACTIVE' AND expiry_date > NOW() AND store_name = ANY($1::text[])`;
  if (store) { params.push(store); where += ` AND store_name = $2`; }
  const r = await query(
      `${DEAL_SELECT} ${where} ORDER BY updated_at DESC LIMIT ${limit + 1}`,
      params
  );

  let deals = await hydrate(r.rows);

  if (deals.length > limit) {
      deals = applyLimits(deals, cfg);
  }
  deals.sort(sortUpdated);
  // Match current Java behavior: shuffle final public list.
  for (let i = deals.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deals[i], deals[j]] = [deals[j], deals[i]]; }
  cache.set(key, deals, 5 * 60 * 1000);
  return deals;
}
async function getById(id) {
  const key = `deal:${id}`; const cached = cache.get(key); if (cached) return cached;
  const r = await query(`${DEAL_SELECT} WHERE id = $1 LIMIT 1`, [id]);
  if (!r.rowCount) return null;
  const deals = await hydrate(r.rows); cache.set(key, deals[0], 5 * 60 * 1000); return deals[0];
}
async function getAdmin(status) {
  const r = await query(`${DEAL_SELECT}${status ? ' WHERE status = $1' : ''} ORDER BY updated_at DESC`, status ? [status] : []);
  return hydrate(r.rows);
}
async function create(deal, source = 'MANUAL') {
  const r = await query(`INSERT INTO deal
    (slug,title,description,price,original_price,currency,image_url,original_image_url,product_url,deal_type,store_name,location,enabled,expiry_date,source_url,deal_source,status,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [
      deal.slug,deal.title,deal.description,deal.price ?? 0,deal.originalPrice ?? 0,deal.currency ?? 'JOD',deal.imageUrl,deal.originalImageUrl ?? null,deal.productUrl,deal.dealType?.toUpperCase(),deal.storeName,deal.location,deal.enabled ?? true,deal.expiryDate,deal.sourceUrl,source,deal.status ?? 'ACTIVE',deal.metadata ?? null]);
  cache.clear(); return getById(r.rows[0].id);
}
async function update(id, data) {
  const allowed = {
    slug:'slug',title:'title',description:'description',price:'price',originalPrice:'original_price',currency:'currency',imageUrl:'image_url',originalImageUrl:'original_image_url',productUrl:'product_url',dealType:'deal_type',storeName:'store_name',location:'location',enabled:'enabled',expiryDate:'expiry_date',sourceUrl:'source_url',dealSource:'deal_source',status:'status',metadata:'metadata'
  };
  const sets=[]; const vals=[];
  for (const [k,col] of Object.entries(allowed)) if (data[k] !== undefined) { vals.push(k === 'dealType' || k === 'dealSource' || k === 'status' ? String(data[k]).toUpperCase() : data[k]); sets.push(`${col} = $${vals.length}`); }
  if (!sets.length) return getById(id);
  vals.push(id); const r=await query(`UPDATE deal SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING id`, vals);
  if (!r.rowCount) throw Object.assign(new Error('Deal not found'), {status:404}); cache.clear(); return getById(id);
}
async function remove(id) { await query('DELETE FROM deal WHERE id=$1', [id]); cache.clear(); }
async function bulkCreate(deals) { return transaction(async client => { const out=[]; for(const d of deals){ const r=await client.query(`INSERT INTO deal (slug,title,description,price,original_price,currency,image_url,original_image_url,product_url,deal_type,store_name,location,enabled,expiry_date,source_url,deal_source,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [d.slug,d.title,d.description,d.price??0,d.originalPrice??0,d.currency??'JOD',d.imageUrl,d.originalImageUrl??null,d.productUrl,d.dealType?.toUpperCase(),d.storeName,d.location,d.enabled??true,d.expiryDate,d.sourceUrl,d.dealSource??'MANUAL',d.status??'ACTIVE',d.metadata??null]); out.push(r.rows[0].id); } cache.clear(); return hydrate((await client.query(`${DEAL_SELECT} WHERE id = ANY($1::bigint[])`, [out])).rows); }); }
async function bulkStatus(ids,status){ const r=await query('UPDATE deal SET status=$1, updated_at=NOW() WHERE id=ANY($2::bigint[])',[status,ids]); cache.clear(); return r.rowCount; }
async function pageable({provider,type,search,page=0,size=30}) {
  const cfg=readClients(); const stores=enabledStores(cfg); const where=['enabled=true','status=\'ACTIVE\'','expiry_date>NOW()','store_name=ANY($1::text[])']; const params=[stores];
  if(provider){params.push(provider);where.push(`store_name=$${params.length}`);} if(type){params.push(type.toUpperCase());where.push(`deal_type=$${params.length}`);} if(search){params.push(`%${search.toLowerCase()}%`);where.push(`LOWER(title) LIKE $${params.length}`);}
  const count=await query(`SELECT COUNT(*) FROM deal WHERE ${where.join(' AND ')}`,params); const total=Number(count.rows[0].count); params.push(size);params.push(page*size);
  const r=await query(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  return {content:await hydrate(r.rows), pageable:{pageNumber:page,pageSize:size}, totalElements:total,totalPages:Math.ceil(total/size),last:page+1>=Math.ceil(total/size),size,number:page,numberOfElements:r.rowCount,first:page===0,empty:r.rowCount===0};
}
module.exports={activeDeals,getById,getAdmin,create,update,remove,bulkCreate,bulkStatus,pageable};
