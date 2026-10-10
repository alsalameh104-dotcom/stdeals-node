const DEAL_TYPES = [
  'hotel','flight','package','activity','tour','cruise','car_rental','transport','airport_transfer','travel_insurance',
  'phone','mobile','esim','internet','tv','streaming','restaurant','food','cafe','bakery','delivery',
  'event','concert','festival','cinema','theater','entertainment','gaming','electronics','computers','laptop','tablet','smartwatch','accessories','microwave',
  'fashion','clothing','shoes','jewelry','watches','handbags','beauty','health','fitness','spa','salon','cosmetics','pharmacy',
  'home','furniture','appliances','home_decor','garden','kitchen','education','books','course','certification','training',
  'software','subscription','mobile_app','cloud_service','domain','hosting','finance','insurance','banking','credit_card','loan','investment',
  'automotive','car_service','fuel','motorcycle','auto_parts','sports','sports_equipment','gym_membership','outdoor','toys','baby_products','pets',
  'real_estate','rental','property','service','consulting','legal','accounting','marketing','design','gift_card','charity','membership','wholesale','business','other',
  'herooffers','bestsellers','lowestprice','megadeals','homepage','topdeals','toppicks','featured','dealoftheday'
];
const DEAL_STATUSES = ['PENDING','ACTIVE','REJECTED','ARCHIVED'];
const DEAL_SOURCES = ['AUTO','MANUAL'];

function mapImage(row) {
  return { id: row.id, imageUrl: row.image_url, originalImageUrl: row.original_image_url };
}
function mapDeal(row, images = []) {
  if (!row) return null;

  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    description: row.description,

    price: row.price == null ? null : Number(row.price),
    originalPrice: row.original_price == null
        ? null
        : Number(row.original_price),

    country: row.country,
    currency: row.currency,

    priceUsd: row.price_usd == null
        ? null
        : Number(row.price_usd),

    productId: row.product_id == null
        ? null
        : Number(row.product_id),

    imageUrl: row.image_url,
    productUrl: row.product_url,

    dealType: row.deal_type
        ? String(row.deal_type).toLowerCase()
        : null,

    storeName: row.store_name,
    location: row.location,
    enabled: row.enabled,

    expiryDate: row.expiry_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    status: row.status
        ? String(row.status).toUpperCase()
        : null,

    images
  };
}
module.exports = { DEAL_TYPES, DEAL_STATUSES, DEAL_SOURCES, mapDeal, mapImage };
