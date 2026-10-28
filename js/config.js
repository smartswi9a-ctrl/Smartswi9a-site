/* ============================================================
   js/config.js
   CONFIGURATION CENTRALISÉE - SMART SWI9A
   Version 10.0.0 - Lot 49 : documentation client_id Livo

   CHANGEMENTS v10.0.0 :
     - Documentation du client_id Livo (clttgsz40483) en
       commentaire. Aucune valeur en clair (config.js est public).
     - Alias CUSTOMER_CODE_ENV_NAME -> 'LIVO_CLIENT_ID' pour
       documenter l'équivalence vocabulaire (client_id = customer_code).
     - Aucun autre changement vs v9.0.0.

   RAPPEL IMPORTANT : ce fichier ne contient AUCUN commentaire de ligne
   (//) pour résister à un aplatissement éventuel. Tous les commentaires
   sont des blocs (/* ... *\/).
   ============================================================ */

export const VIDEO_BASE_URL = "https://videos.smartswi9a.top/";

/* ============================================================
   MODE TEST / RÉEL
   ============================================================ */
export const APP_MODE = {
  current: "production",
  testBatchId: null,
};

export function isTestMode() {
  return APP_MODE.current === "test";
}

export const CONFIG = {
  FIREBASE: {
    apiKey: "AIzaSyBhULwDxPBRqjywsSD_0ny41Bmt968ofSA",
    authDomain: "smartswi9a-31063.firebaseapp.com",
    projectId: "smartswi9a-31063",
    storageBucket: "smartswi9a-31063.firebasestorage.app",
    messagingSenderId: "933677210664",
    appId: "1:933677210664:web:1ee39f36dfa0806656e91d",
  },
  VERSION: { CITIES_SCHEMA: 4 },
  SHOP: {
    NAME: "Smart Swi9a",
    WHATSAPP_NUMBER: "212656613303",
    EMAIL: "smartswi9a@gmail.com",
    URL: "https://smartswi9a.top",
    CURRENCY: "MAD",
    DISCOUNT_THRESHOLD: 3,
    DISCOUNT_PERCENT: 5,
    FREE_DELIVERY_THRESHOLD: 0,
    DELIVERY_FEE_BASE: 30,
    DELIVERY_FEE_PER_VENDOR_EXTRA: 0,
    ICE: "XXXXXXXXXXXXXXX",
    RC: "XXXXXX",
    PATENTE: "XXXXXXXX",
    ADDRESS: "Casablanca, Maroc",
    LEGAL_REP: "Smart Swi9a SARL",
  },
  STORAGE_KEYS: {
    CART: "swi9a_cart",
    THEME: "swi9a_theme",
    LANG: "swi9a_lang",
    USER: "swi9a_user",
    ABANDONED_CART: "swi9a_abandoned_cart",
    CITIES_CACHE: "swi9a_cities_cache",
    COOKIE_CONSENT: "swi9a_cookie_consent",
    SELECTED_CITY: "swi9a_selected_city",
    VENDOR_MODE: "swi9a_vendor_mode",
    VISITOR_ID: "swi9a_visitor_id",
    SESSION_ID: "swi9a_session_id",
    ANALYTICS_CONSENT: "swi9a_analytics_consent",
  },
  PRODUCTS: { PER_PAGE: 8, DEFAULT_RATING: 4.8, MAX_REVIEW_PHOTOS: 5 },
  BLOG: {
    PER_PAGE: 6,
    MAX_TITLE_LENGTH: 120,
    MAX_EXCERPT_LENGTH: 250,
    MAX_CONTENT_LENGTH: 50000,
    CATEGORIES: [],
  },
  SESSION: {
    IDLE_TIMEOUT: 30 * 60 * 1000,
    ABANDONED_CART_DELAY: 30 * 60 * 1000,
  },
  ORDERS: {
    CANCELLABLE_HOURS: 4,
    STATUS: {
      PENDING: "pending",
      CONFIRMED: "confirmed",
      SHIPPING: "shipping",
      DELIVERED: "delivered",
      RETURNED: "returned",
      CANCELLED: "cancelled",
    },
    LEGACY_STATUS: { VALIDATED: "validated", RECEIVED: "received" },
    PAYMENT: { UNPAID: "unpaid", PAID: "paid" },
    RETURNABLE_FROM: ["confirmed", "shipping", "delivered"],
    EMAIL_ON_STATUS: {},
  },
  REVIEWS: {
    MAX_PHOTOS: 5,
    MAX_FEATURED: 3,
    STATUS: { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" },
  },
  NOTIFICATIONS: {
    TYPES: {
      ORDER_CREATED: "order_created",
      ORDER_CONFIRMED: "order_confirmed",
      ORDER_SHIPPING: "order_shipping",
      ORDER_DELIVERED: "order_delivered",
      ORDER_RETURNED: "order_returned",
      ORDER_CANCELLED: "order_cancelled",
      REVIEW_APPROVED: "review_approved",
      REVIEW_REQUEST: "review_request",
      VENDOR_OVERDUE: "vendor_overdue",
      VENDOR_SUSPENDED: "vendor_suspended",
      WALLET_UNLOCKED: "wallet_unlocked",
      FULFILLMENT_APPROVED: "fulfillment_approved",
      FULFILLMENT_REJECTED: "fulfillment_rejected",
      FULFILLMENT_LABEL_READY: "fulfillment_label_ready",
      FULFILLMENT_RECEIVED: "fulfillment_received",
      FULFILLMENT_DEPLETED: "fulfillment_depleted",
      FULFILLMENT_OVERDUE: "fulfillment_overdue",
      PAYOUT_APPROVED: "payout_approved",
      PAYOUT_PAID: "payout_paid",
      PAYOUT_REJECTED: "payout_rejected",
      STORAGE_FEE_CHARGED: "storage_fee_charged",
    },
  },
  SIGNUP_METHODS: {
    OTP: "otp",
    GOOGLE: "google",
    FACEBOOK: "facebook",
    VENDOR: "vendor",
  },
  BREAKPOINTS: {
    MOBILE_MAX: 480,
    TABLET_MIN: 481,
    TABLET_MAX: 1024,
    DESKTOP_MIN: 1025,
    LARGE_MIN: 1441,
  },

  /* ============================================================
       MARKETPLACE / VENDEURS
       ============================================================ */
  VENDOR: {
    COMMISSION_RATE: 0.07,
    COMMISSION_RATE_MIN: 0.05,
    COMMISSION_RATE_MAX: 0.15,
    UNLOCK_DAYS_VENDOR: 7,
    UNLOCK_DAYS_SMART: 15,
    MIN_WITHDRAWAL: 200,
    MAX_NEGATIVE_BALANCE: -1000,
    SUSPEND_DEBT_DAYS: 30,
    /* Alias déprécié : conservé pour compatibilité. Retiré au lot « cleanup » final. */
    RETURN_FEE_SPEEDAF: 20,
    /* Nouveau nom canonique - à utiliser pour tout nouveau code. */
    RETURN_FEE_LIVO: 20,
    FULFILLMENT_FEE_PER_UNIT_MONTH: 5,
    FULFILLMENT_MAX_UNITS: 10,
    FULFILLMENT_MAX_UNITS_PER_BATCH: 10,
    FULFILLMENT_MAX_ITEMS_PER_BATCH: 5,
    FULFILLMENT_ADMIN_VALIDATION_HOURS: 48,
    FULFILLMENT_LABEL_VALIDITY_DAYS: 30,
    FULFILLMENT_LOW_STOCK_THRESHOLD: 2,
    DROPOFF_DEADLINE_HOURS_NEW: 72,
    DROPOFF_DEADLINE_HOURS_ESTABLISHED: 48,
    DROPOFF_ACCOUNT_MATURITY_DAYS: 30,
    DROPOFF_MAX_DELAYS_BEFORE_SUSPEND: 3,
    LATE_ORDER_PENALTY: 0,
    LABEL_BARCODE_PREFIX: "SSW-",
    LABEL_FORMAT: "PDF",
    PRODUCT_VALIDATION_HOURS: 48,
    VENDOR_VALIDATION_HOURS: 72,
    CONTRACT_VERSION: "1.2.0",
    CONTRACT_RESIGN_GRACE_DAYS: 30,
    ALLOWED_CATEGORIES: [],
  },

  /* ============================================================
       LOGISTIQUE & SÉCURITÉ (Workers Cloudflare)
       ============================================================ */
  LOGISTICS: {
    PROVIDER: "livo",
    PROVIDER_API_URL: "https://rest.livo.ma",
    PROXY_WORKER_URL: "https://livo-proxy.smartswi9a.workers.dev",
    AGENCIES_FIRESTORE_COLLECTION: "livo_agencies",
    LEGACY_AGENCIES_COLLECTION: "speedaf_agencies",
    PICKUPS_FIRESTORE_COLLECTION: "livo_pickups",
    LEGACY_PICKUPS_COLLECTION: "speedaf_pickups",
    SENDER_NAME: "Smart Swi9a",
    SENDER_PHONE: "212656613303",
    USE_FIRESTORE_CITIES: true,
  },

  /* ============================================================
       LIVO - CONFIGURATION SPÉCIFIQUE API ENTREPÔT
       ============================================================
       Référence : OpenAPI 1.0.0 (rest.livo.ma).
       - Authentification : Bearer <api-key> (jamais côté client).
       - Rate limit global : 5 req/s.
       - Rate limit /orders/receive : 600 appels/heure par clé.
       - Format IDs : pr-xxxxxxxx (produit), or-xxxxxxxx (commande),
         pi-xxxxxxxx (ramassage), it-xxxxxxxx (item), us-xxxxxxxx (livreur).
       - Dates : JJ/MM/AAAA pour desired_date.
       - Enveloppe succès : { success: true, data: { ... } }
       - Enveloppe erreur : { success: false, data: { en_message, fr_message, error, type, details } }
       ============================================================ */
  LIVO: {
    BASE_URL: "https://rest.livo.ma",
    /* Identifiants : les NOMS uniquement. Les VALEURS sont injectées via les
           secrets Cloudflare Worker. Ne JAMAIS mettre de vraie clé ici : ce
           fichier est public (chargé côté navigateur). */
    API_KEY_ENV_NAME: "LIVO_API_KEY",
    /* Client ID Livo : "clttgsz40483" (confirmé par le responsable technique
           Livo, session 8). C'est le code marchand utilisé dans
           AddPickupRequest.client_id (POST /pickups).
           ⚠️ Valeur stockée UNIQUEMENT dans le secret Cloudflare LIVO_CLIENT_ID.
           NE JAMAIS la mettre en clair dans ce fichier (config.js est public). */
    CLIENT_ID_ENV_NAME: "LIVO_CLIENT_ID",
    /* Alias documentaire : dans le vocabulaire Livo, "client_id" et
           "customer_code" désignent la même valeur. Pointe vers le même secret. */
    CUSTOMER_CODE_ENV_NAME: "LIVO_CLIENT_ID",
    WEBHOOK_SECRET_ENV_NAME: "LIVO_WEBHOOK_SECRET",
    /* Rate limit : 5 req/s global. Les Workers appliquent un backoff sur 429. */
    RATE_LIMIT_PER_SECOND: 5,
    /* Endpoints (chemins relatifs à BASE_URL). */
    ENDPOINTS: {
      VERIFY_KEY: "/auth/keys",
      ORDER_CREATE: "/orders",
      ORDER_LIST: "/orders",
      ORDER_GET: "/orders/{id}",
      ORDER_EDIT: "/orders",
      ORDER_RECEIVE: "/orders/receive",
      ORDER_STATUSES: "/orders/statuses",
      PICKUP_CREATE: "/pickups",
      PICKUP_LIST: "/pickups",
      PICKUP_GET: "/pickups/{id}",
      PICKUP_EDIT: "/pickups",
      PICKUP_DELETE: "/pickups",
      PRODUCT_LIST: "/products",
      PRODUCT_GET: "/products/{id}",
      PRODUCT_STOCK: "/products/stock",
      PRODUCT_UPDATE: "/products",
      PRODUCT_DELETE: "/products",
      CITY_LIST: "/cities",
      CITY_GET: "/cities/{id}",
      FEES_PUBLIC: "/fees/public",
    },
    /* Pagination par défaut (max 500). */
    DEFAULT_PAGE_LIMIT: 500,
    /* Version OpenAPI sur laquelle ce code a été écrit. */
    API_VERSION: "1.0.0",
  },

  SECURITY: {
    IP_WORKER_URL: "https://worker-ip.smartswi9a.workers.dev",
    CRON_WORKER_URL: "https://worker-cron.smartswi9a.workers.dev",
    CONTRACT_HASH_ALGO: "SHA-256",
  },

  /* ============================================================
       COMPTABILITÉ & STATISTIQUES
       ============================================================ */
  ACCOUNTING: {
    TVA_ENABLED: false,
    TVA_RATE: 0.2,
    CURRENCY: "MAD",
    DECIMAL_PRECISION: 2,
    LEDGER_ENABLED: true,
    LEDGER_RETENTION_YEARS: 10,
    EXPORT_FORMATS: ["csv", "pdf"],
    EXPORT_MAX_ROWS: 10000,
    FISCAL_YEAR_START: "01-01",
    MONTHLY_REPORT_DAY: 1,
    RECONCILE_AUTO: true,
    RECONCILE_TOLERANCE_MAD: 0.01,
  },
  STATS: {
    DAILY_CRON_ENABLED: true,
    DAILY_CRON_HOUR: 0,
    DAILY_CRON_MINUTE: 5,
    MONTHLY_CRON_DAY: 1,
    MONTHLY_CRON_HOUR: 0,
    MONTHLY_CRON_MINUTE: 10,
    DAILY_STATS_RETENTION_DAYS: 730,
    VENDOR_STATS_RETENTION_DAYS: 730,
    KEEP_MONTHLY_AGGREGATES: true,
    LIVE_REFRESH_INTERVAL_MS: 60000,
    CHART_DEFAULT_PERIOD: 30,
    CHART_PERIODS: [7, 30, 90, 365],
    COMPARE_WITH_PREVIOUS_PERIOD: true,
    TOP_PRODUCTS_LIMIT: 10,
    TOP_VENDORS_LIMIT: 10,
    TOP_CATEGORIES_LIMIT: 10,
  },
  ANALYTICS: {
    HEARTBEAT_INTERVAL_MS: 30000,
    LIVE_TTL_MS: 5 * 60 * 1000,
    SESSION_TIMEOUT_MS: 30 * 60 * 1000,
    VISITOR_ID_RETENTION_MS: 365 * 24 * 3600 * 1000,
    CLEANUP_CRON_MINUTES: 5,
    RESPECT_COOKIE_CONSENT: true,
    WEIGHT_VIEW: 1,
    WEIGHT_SEARCH: 3,
    WEIGHT_SALE: 10,
    WEIGHT_RATING: 5,
    BASE_WEIGHT: 10,
    RELATED_PRODUCTS_COUNT: 6,
    RELATED_RELEVANCE_BONUS: 1.3,
    RELATED_MAX_PER_CATEGORY: 2,
    TRACK_DEDUP_SESSION: true,
    TRACK_SEARCH_DEDUP_MS: 300000,
  },
  AUTOMATION: {
    CRON_EVERY_15MIN_ENABLED: true,
    CRON_EVERY_HOUR_ENABLED: true,
    CRON_DAILY_ENABLED: true,
    CRON_MONTHLY_ENABLED: true,
    LIVO_SYNC_FALLBACK_HOURS: 1,
    LIVO_SYNC_BATCH_SIZE: 50,
    /* Alias dépréciés : conservés pour compatibilité Workers actuels. */
    SPEEDAF_SYNC_FALLBACK_HOURS: 1,
    SPEEDAF_SYNC_BATCH_SIZE: 50,
    DEADLINE_WARNING_HOURS: [24, 6],
    OVERDUE_CHECK_INTERVAL_HOURS: 1,
    WALLET_UNLOCK_AUTO: true,
    WALLET_UNLOCK_CHECK_HOUR: 0,
    WALLET_UNLOCK_CHECK_MINUTE: 15,
    STORAGE_BILLING_DAY: 1,
    STORAGE_BILLING_HOUR: 0,
    STORAGE_BILLING_MINUTE: 30,
    EMAIL_DAILY_ADMIN_SUMMARY: true,
    EMAIL_DAILY_VENDOR_SUMMARY: true,
    EMAIL_MONTHLY_REPORTS: true,
    AUTO_SUSPEND_VENDORS: true,
    AUTO_SUSPEND_NEGATIVE_BALANCE: true,
    WEBHOOKS_ENABLED: true,
    /* SÉCURITÉ : ne JAMAIS mettre le secret réel ici. */
    WEBHOOK_LIVO_SECRET: "__MIGRATED_TO_WORKER_ENV__",
    WEBHOOK_RETRY_ATTEMPTS: 3,
    WEBHOOK_RETRY_DELAY_MS: 5000,
  },
  FULFILLMENT_BATCH_PREFIX: "FUL-",
  FULFILLMENT_LABEL_PREFIX: "SSW-FUL-",
};

export const CURRENCY_SUFFIX = { fr: "MAD", ar: "درهم", en: "MAD" };
export const ROLES = { USER: "user", ADMIN: "admin", VENDOR: "vendor" };

export const ORDER_STATUS = CONFIG.ORDERS.STATUS;
export const ORDER_LEGACY_STATUS = CONFIG.ORDERS.LEGACY_STATUS;
export const PAYMENT_STATUS = CONFIG.ORDERS.PAYMENT;
export const REVIEW_STATUS = CONFIG.REVIEWS.STATUS;
export const NOTIFICATION_TYPES = CONFIG.NOTIFICATIONS.TYPES;
export const SIGNUP_METHODS = CONFIG.SIGNUP_METHODS;

/* ============================================================
   STATUTS VENDEURS & MARKETPLACE
   ============================================================ */
export const VENDOR_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
};
export const VENDOR_SHIPPING_METHOD = {
  DROPOFF: "dropoff",
  FULFILLMENT: "fulfillment",
};

export const PRODUCT_STATUS = {
  PENDING: "pending",
  PENDING_ADMIN_APPROVAL: "pending_admin_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
  DRAFT: "draft",
};

export const VALID_PRODUCT_STATUSES = Object.values(PRODUCT_STATUS);
export function isValidProductStatus(status) {
  return VALID_PRODUCT_STATUSES.includes(status);
}

export const VENDOR_ORDER_STATUS = {
  PENDING: "pending",
  AWAITING_DROPOFF: "awaiting_dropoff",
  OVERDUE: "overdue",
  DROPOFF_RECEIVED: "dropoff_received",
  PREPARING: "preparing",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  RETURNED: "returned",
  CANCELLED: "cancelled",
};
export const FULFILLMENT_STATUS = {
  PENDING_ADMIN_APPROVAL: "pending_admin_approval",
  APPROVED: "approved",
  LABEL_SENT: "label_sent",
  IN_TRANSIT: "in_transit",
  RECEIVED_BY_LIVO: "received_by_livo",
  ACTIVE_STOCK: "active_stock",
  DEPLETED: "depleted",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  OVERDUE_NOT_SHIPPED: "overdue_not_shipped",
  RECEIVED_BY_SPEEDAF: "received_by_livo",
};
export const WALLET_TX_TYPE = {
  SALE: "sale",
  RETURN_FEE: "return_fee",
  PAYOUT: "payout",
  PENALTY: "penalty",
  STORAGE_FEE: "storage_fee",
  STORAGE_REFUND: "storage_refund",
  ADJUSTMENT: "adjustment",
};
export const WALLET_TX_STATUS = {
  PENDING: "pending",
  RELEASED: "released",
  CANCELLED: "cancelled",
};
export const PAYOUT_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  PAID: "paid",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
};
export const CONTRACT_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REVOKED: "revoked",
};

export const LEDGER_TYPE = {
  INCOME: "income",
  EXPENSE: "expense",
  TRANSFER: "transfer",
};
export const LEDGER_CATEGORY = {
  PRODUCT_SALE_SMART: "product_sale_smart",
  PRODUCT_SALE_VENDOR: "product_sale_vendor",
  SHIPPING_FEE: "shipping_fee",
  VENDOR_COMMISSION: "vendor_commission",
  STORAGE_FEE: "storage_fee",
  PENALTY_INCOME: "penalty_income",
  COGS_SMART: "cogs_smart",
  VENDOR_NET_PAYMENT: "vendor_net_payment",
  LIVO_FEE: "livo_fee",
  RETURN_FEE_ABSORBED: "return_fee_absorbed",
  MARKETING: "marketing",
  OTHER_EXPENSE: "other_expense",
  COD_COLLECTION: "cod_collection",
  PAYOUT_TRANSFER: "payout_transfer",
  WALLET_UNLOCK: "wallet_unlock",
  SPEEDAF_FEE: "livo_fee",
};

export const STATUS_MIGRATION_MAP = {
  validated: "confirmed",
  received: "delivered",
};
export function normalizeOrderStatus(status) {
  if (!status) return ORDER_STATUS.PENDING;
  return STATUS_MIGRATION_MAP[status] || status;
}

/* Mapping complet des anciennes catégories vers les nouvelles */
export const LEGACY_CATEGORY_MAP = {
  electronics: "smartphones",
  smartphone: "smartphones",
  tablet: "computers",
  watch: "wearables",
  accessory: "tech-accessories",
  home: "smart-home",
  fashion: "fashion",
  "baby-kids": "toys",
  "auto-moto": "auto",
  office: "office",
  misc: "tools",
  audio: "audio",
  beauty: "beauty",
  sport: "sports",
  game: "games",
  toy: "toys",
  pet: "pets",
  camera: "cameras",
  security: "security",
  tool: "tools",
};

export function normalizeCategory(catId) {
  if (!catId) return "all";
  return LEGACY_CATEGORY_MAP[catId] || catId;
}

/* Référence CATEGORY_GROUPS déclarée plus bas. Sûr en ES module. */
export function productMatchesCategory(product, categoryId) {
  if (!categoryId || categoryId === "all") return true;
  if (!product || !product.category) return false;
  const productCat = product.category;
  const normalized = normalizeCategory(productCat);
  if (productCat === categoryId) return true;
  if (normalized === categoryId) return true;
  const parent = CATEGORY_GROUPS.find((g) => g.id === categoryId);
  if (parent)
    return parent.children.some(
      (c) => c.id === productCat || c.id === normalized
    );
  return false;
}

export function canReturnOrder(order) {
  if (!order) return false;
  return CONFIG.ORDERS.RETURNABLE_FROM.includes(
    normalizeOrderStatus(order.status)
  );
}

export function getReturnedQuantities(order) {
  const result = {};
  if (!order || !order.returns || !Array.isArray(order.returns)) return result;
  order.returns.forEach((r) => {
    if (!r.items || !Array.isArray(r.items)) return;
    r.items.forEach((item) => {
      if (!item.productId) return;
      const pid = String(item.productId);
      result[pid] = (result[pid] || 0) + (Number(item.delta) || 0);
    });
  });
  return result;
}

export function isFullReturn(order) {
  if (!order || !order.items) return false;
  const returned = getReturnedQuantities(order);
  return order.items.every(
    (item) =>
      (returned[String(item.productId)] || 0) >= (Number(item.quantity) || 0)
  );
}

/* ============================================================
   HELPERS MARKETPLACE (Calculs)
   ============================================================ */
export function isVendorProduct(product) {
  return !!(product && product.vendorId && product.vendorId !== "smartswi9a");
}

export function getProductOwner(product) {
  if (!product) return null;
  return product.vendorId || "smartswi9a";
}

export function getCommissionRate(vendor) {
  const defaultRate = CONFIG.VENDOR.COMMISSION_RATE;
  if (!vendor) return defaultRate;
  const customRate = vendor.vendorInfo?.commissionRate ?? vendor.commissionRate;
  if (typeof customRate !== "number" || !Number.isFinite(customRate))
    return defaultRate;
  const min = CONFIG.VENDOR.COMMISSION_RATE_MIN;
  const max = CONFIG.VENDOR.COMMISSION_RATE_MAX;
  return Math.min(max, Math.max(min, customRate));
}

export function calculateVendorCommission(subtotal, vendor = null) {
  const rate = getCommissionRate(vendor);
  const subtotalNum = Math.max(0, Number(subtotal) || 0);
  const commission = Math.round(subtotalNum * rate * 100) / 100;
  const netToPay = Math.round((subtotalNum - commission) * 100) / 100;
  return { subtotal: subtotalNum, commissionRate: rate, commission, netToPay };
}

export function getWalletUnlockDays(isSmartProduct) {
  return isSmartProduct
    ? CONFIG.VENDOR.UNLOCK_DAYS_SMART
    : CONFIG.VENDOR.UNLOCK_DAYS_VENDOR;
}

export function calculateDeliveryFee(vendorCount = 1) {
  const count = Math.max(1, Number(vendorCount) || 1);
  const base = CONFIG.SHOP.DELIVERY_FEE_BASE;
  const extra = CONFIG.SHOP.DELIVERY_FEE_PER_VENDOR_EXTRA;
  return base + Math.max(0, count - 1) * extra;
}

export function getReturnFeeForVendor() {
  return CONFIG.VENDOR.RETURN_FEE_LIVO;
}

export function canVendorSell(vendor) {
  if (!vendor || !vendor.vendorInfo) return false;
  return (
    vendor.vendorInfo.status === VENDOR_STATUS.APPROVED &&
    vendor.vendorInfo.contractStatus === CONTRACT_STATUS.ACCEPTED
  );
}

export function isProductPubliclyVisible(product, vendor = null) {
  if (!product) return false;
  if (!isVendorProduct(product)) return true;
  if (product.status !== PRODUCT_STATUS.APPROVED) return false;
  if (vendor && !canVendorSell(vendor)) return false;
  return true;
}

export function calculateStorageFee(units) {
  const count = Math.max(
    0,
    Math.min(CONFIG.VENDOR.FULFILLMENT_MAX_UNITS, Number(units) || 0)
  );
  return count * CONFIG.VENDOR.FULFILLMENT_FEE_PER_UNIT_MONTH;
}

export function getDropoffDeadline(confirmedAt, vendorAgeDays = 0) {
  const hours =
    Number(vendorAgeDays) >= CONFIG.VENDOR.DROPOFF_ACCOUNT_MATURITY_DAYS
      ? CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_ESTABLISHED
      : CONFIG.VENDOR.DROPOFF_DEADLINE_HOURS_NEW;
  const d = confirmedAt instanceof Date ? confirmedAt : new Date(confirmedAt);
  return new Date(d.getTime() + hours * 3600 * 1000);
}

export function generateVendorLabelBarcode(prefix = "CMD") {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `${CONFIG.VENDOR.LABEL_BARCODE_PREFIX}${prefix}-${ymd}-${rand}`;
}

export const LANGUAGES = ["fr", "ar", "en"];
export const DEFAULT_LANGUAGE = "fr";

/* ============================================================
   LIVO - MAPPINGS STATUTS
   ============================================================ */
export const LIVO_STATUS_MAP = {
  draft: ORDER_STATUS.PENDING,
  pending: ORDER_STATUS.PENDING,
  "in progress": ORDER_STATUS.SHIPPING,
  fulfilled: ORDER_STATUS.DELIVERED,
  problem: ORDER_STATUS.SHIPPING,
  cancelled: ORDER_STATUS.CANCELLED,
  "awaiting transfer": ORDER_STATUS.SHIPPING,
  "awaiting pickup": ORDER_STATUS.CONFIRMED,
  reported: ORDER_STATUS.SHIPPING,
  programmed: ORDER_STATUS.CONFIRMED,
};

export const LIVO_RETURN_STATUS_MAP = {
  "returned-pending": { status: "returned", phase: "pending" },
  "returned-started": { status: "returned", phase: "started" },
  "returned-warehouse": { status: "returned", phase: "warehouse" },
  "returned-fully": { status: "returned", phase: "fully" },
};

export function mapLivoStatusToSmart(livoStatus) {
  if (!livoStatus) return { status: ORDER_STATUS.PENDING, unknown: false };
  const key = String(livoStatus).toLowerCase().trim();
  const mapped = LIVO_STATUS_MAP[key];
  if (mapped) return { status: mapped, unknown: false };
  return { status: ORDER_STATUS.SHIPPING, unknown: true };
}

/* ============================================================
   CATÉGORIES (23 PARENTS + ENFANTS)
   ============================================================ */
export const CATEGORY_GROUPS = [
  {
    id: "smartphones",
    label: "filterSmartphones",
    emoji: "📱",
    children: [
      { id: "smartphones-android", label: "filterAndroid", emoji: "🤖" },
      { id: "smartphones-ios", label: "filterIOS", emoji: "🍏" },
      {
        id: "smartphones-accessories",
        label: "filterPhoneAccessories",
        emoji: "🔌",
      },
    ],
  },
  {
    id: "audio",
    label: "filterAudio",
    emoji: "🎧",
    children: [
      { id: "audio-headphones", label: "filterHeadphones", emoji: "🎧" },
      { id: "audio-earbuds", label: "filterEarbuds", emoji: "🎵" },
      { id: "audio-speakers", label: "filterSpeakers", emoji: "🔊" },
    ],
  },
  {
    id: "computers",
    label: "filterComputers",
    emoji: "💻",
    children: [
      { id: "computers-laptops", label: "filterLaptops", emoji: "💻" },
      { id: "computers-desktops", label: "filterDesktops", emoji: "🖥️" },
      {
        id: "computers-accessories",
        label: "filterPcAccessories",
        emoji: "🖱️",
      },
    ],
  },
  {
    id: "wearables",
    label: "filterWearables",
    emoji: "⌚",
    children: [
      {
        id: "wearables-smartwatches",
        label: "filterSmartwatches",
        emoji: "⌚",
      },
      { id: "wearables-fitness", label: "filterFitness", emoji: "🏃" },
    ],
  },
  {
    id: "tech-accessories",
    label: "filterTechAccessories",
    emoji: "🔌",
    children: [
      { id: "tech-chargers", label: "filterChargers", emoji: "⚡" },
      { id: "tech-cables", label: "filterCables", emoji: "🔗" },
      { id: "tech-powerbanks", label: "filterPowerbanks", emoji: "🔋" },
    ],
  },
  {
    id: "cameras",
    label: "filterCameras",
    emoji: "📷",
    children: [
      { id: "cameras-dslr", label: "filterDslr", emoji: "📸" },
      { id: "cameras-action", label: "filterActionCameras", emoji: "🎥" },
      { id: "cameras-drones", label: "filterDrones", emoji: "🚁" },
    ],
  },
  {
    id: "smart-home",
    label: "filterSmartHome",
    emoji: "🏠",
    children: [
      { id: "smart-home-lighting", label: "filterSmartLighting", emoji: "💡" },
      { id: "smart-home-security", label: "filterSmartSecurity", emoji: "🔒" },
      { id: "smart-home-speakers", label: "filterSmartSpeakers", emoji: "🗣️" },
    ],
  },
  {
    id: "kitchen",
    label: "filterKitchen",
    emoji: "🍳",
    children: [
      {
        id: "kitchen-appliances",
        label: "filterKitchenAppliances",
        emoji: "🍳",
      },
      { id: "kitchen-cookware", label: "filterCookware", emoji: "🍲" },
      { id: "kitchen-coffee", label: "filterCoffeeMachines", emoji: "☕" },
    ],
  },
  {
    id: "furniture",
    label: "filterFurniture",
    emoji: "🪑",
    children: [
      { id: "furniture-chairs", label: "filterChairs", emoji: "🪑" },
      { id: "furniture-tables", label: "filterTables", emoji: "🪵" },
      { id: "furniture-storage", label: "filterStorage", emoji: "📦" },
    ],
  },
  {
    id: "decoration",
    label: "filterDecoration",
    emoji: "🖼️",
    children: [
      { id: "decoration-lighting", label: "filterLamps", emoji: "💡" },
      { id: "decoration-plants", label: "filterPlants", emoji: "🪴" },
      { id: "decoration-art", label: "filterArt", emoji: "🎨" },
    ],
  },
  {
    id: "fashion",
    label: "filterFashion",
    emoji: "👗",
    children: [
      { id: "fashion-men", label: "filterMen", emoji: "👔" },
      { id: "fashion-women", label: "filterWomen", emoji: "👗" },
      { id: "fashion-shoes", label: "filterShoes", emoji: "👟" },
      { id: "fashion-bags", label: "filterBags", emoji: "👜" },
    ],
  },
  {
    id: "beauty",
    label: "filterBeauty",
    emoji: "💄",
    children: [
      { id: "beauty-makeup", label: "filterMakeup", emoji: "💄" },
      { id: "beauty-skincare", label: "filterSkincare", emoji: "🧴" },
      { id: "beauty-fragrances", label: "filterFragrances", emoji: "🌸" },
    ],
  },
  {
    id: "haircare",
    label: "filterHaircare",
    emoji: "💇",
    children: [
      { id: "haircare-dryers", label: "filterHairDryers", emoji: "💨" },
      { id: "haircare-stylers", label: "filterHairStylers", emoji: "🔥" },
      { id: "haircare-products", label: "filterHairProducts", emoji: "🧴" },
    ],
  },
  {
    id: "auto",
    label: "filterAuto",
    emoji: "🚗",
    children: [
      { id: "auto-interior", label: "filterAutoInterior", emoji: "🪑" },
      { id: "auto-exterior", label: "filterAutoExterior", emoji: "🚙" },
      { id: "auto-tools", label: "filterAutoTools", emoji: "🔧" },
    ],
  },
  {
    id: "car-electronics",
    label: "filterCarElectronics",
    emoji: "📻",
    children: [
      { id: "car-electronics-dashcams", label: "filterDashcams", emoji: "📹" },
      { id: "car-electronics-gps", label: "filterGps", emoji: "🗺️" },
      { id: "car-electronics-audio", label: "filterCarAudio", emoji: "🔊" },
    ],
  },
  {
    id: "tools",
    label: "filterTools",
    emoji: "🔨",
    children: [
      { id: "tools-hand", label: "filterHandTools", emoji: "🔨" },
      { id: "tools-boxes", label: "filterToolBoxes", emoji: "🧰" },
      { id: "tools-garden", label: "filterGardenTools", emoji: "🌱" },
    ],
  },
  {
    id: "power-tools",
    label: "filterPowerTools",
    emoji: "🔌",
    children: [
      { id: "power-tools-drills", label: "filterDrills", emoji: "🪚" },
      { id: "power-tools-saws", label: "filterSaws", emoji: "🪚" },
      { id: "power-tools-sanders", label: "filterSanders", emoji: "⚙️" },
    ],
  },
  {
    id: "security",
    label: "filterSecurity",
    emoji: "🔒",
    children: [
      { id: "security-cameras", label: "filterSecurityCameras", emoji: "📹" },
      { id: "security-locks", label: "filterSmartLocks", emoji: "🔐" },
      { id: "security-alarms", label: "filterAlarms", emoji: "🚨" },
    ],
  },
  {
    id: "sports",
    label: "filterSports",
    emoji: "⚽",
    children: [
      { id: "sports-fitness", label: "filterFitnessGear", emoji: "🏋️" },
      { id: "sports-football", label: "filterFootball", emoji: "⚽" },
      { id: "sports-outdoor", label: "filterOutdoor", emoji: "⛺" },
    ],
  },
  {
    id: "games",
    label: "filterGames",
    emoji: "🎮",
    children: [
      { id: "games-consoles", label: "filterConsoles", emoji: "🎮" },
      { id: "games-controllers", label: "filterControllers", emoji: "🕹️" },
      { id: "games-games", label: "filterVideoGames", emoji: "💿" },
    ],
  },
  {
    id: "toys",
    label: "filterToys",
    emoji: "🧸",
    children: [
      { id: "toys-rc", label: "filterRcToys", emoji: "🚗" },
      { id: "toys-educational", label: "filterEducationalToys", emoji: "🧩" },
      { id: "toys-dolls", label: "filterDolls", emoji: "🪆" },
    ],
  },
  {
    id: "pets",
    label: "filterPets",
    emoji: "🐾",
    children: [
      { id: "pets-food", label: "filterPetFood", emoji: "🦴" },
      { id: "pets-toys", label: "filterPetToys", emoji: "🎾" },
      { id: "pets-accessories", label: "filterPetAccessories", emoji: "🐕" },
    ],
  },
  {
    id: "office",
    label: "filterOffice",
    emoji: "📄",
    children: [
      { id: "office-stationery", label: "filterStationery", emoji: "✏️" },
      { id: "office-furniture", label: "filterOfficeFurniture", emoji: "🪑" },
      {
        id: "office-electronics",
        label: "filterOfficeElectronics",
        emoji: "🖨️",
      },
    ],
  },
];

/* ============================================================
   INDEX DES CATÉGORIES
   ============================================================ */
let _categoryIndexCache = null;
function buildCategoryIndex() {
  if (_categoryIndexCache) return _categoryIndexCache;
  const index = new Map();
  index.set("all", {
    id: "all",
    label: "filterAll",
    emoji: "🛍️",
    isParent: false,
    parentId: null,
  });
  index.set("favorites", {
    id: "favorites",
    label: "filterFavorites",
    emoji: "❤️",
    isParent: false,
    parentId: null,
  });
  CATEGORY_GROUPS.forEach((group) => {
    index.set(group.id, {
      id: group.id,
      label: group.label,
      emoji: group.emoji,
      isParent: true,
      parentId: null,
    });
    group.children.forEach((child) => {
      index.set(child.id, {
        id: child.id,
        label: child.label,
        emoji: child.emoji,
        isParent: false,
        parentId: group.id,
      });
    });
  });
  _categoryIndexCache = index;
  return index;
}

export function getCategoryById(catId) {
  if (!catId) return null;
  const index = buildCategoryIndex();
  return index.get(catId) || index.get(normalizeCategory(catId)) || null;
}

export function getParentCategory(catId) {
  const cat = getCategoryById(catId);
  if (!cat) return null;
  if (cat.isParent) return cat;
  return cat.parentId ? getCategoryById(cat.parentId) : null;
}

export function getCategoryPath(catId) {
  const cat = getCategoryById(catId);
  if (!cat) return [];
  if (cat.isParent) return [cat];
  const parent = cat.parentId ? getCategoryById(cat.parentId) : null;
  return parent ? [parent, cat] : [cat];
}

export const CATEGORIES = [
  { id: "all", label: "filterAll", emoji: "🛍️" },
  { id: "favorites", label: "filterFavorites", emoji: "❤️" },
];
CATEGORY_GROUPS.forEach((group) => {
  CATEGORIES.push({
    id: group.id,
    label: group.label,
    emoji: group.emoji,
    isParent: true,
  });
  group.children.forEach((child) => {
    CATEGORIES.push({
      id: child.id,
      label: child.label,
      emoji: child.emoji,
      parentId: group.id,
    });
  });
});

export const SORT_OPTIONS = [
  { value: "default", label: "sortDefault" },
  { value: "price-asc", label: "sortPriceAsc" },
  { value: "price-desc", label: "sortPriceDesc" },
  { value: "name-asc", label: "sortNameAsc" },
  { value: "name-desc", label: "sortNameDesc" },
  { value: "rating", label: "sortRating" },
];

console.log(
  "✅ config.js chargé - v10.0.0 (Lot 49 : documentation client_id Livo)"
);