// Live product + stock lookup.
// WITH WooCommerce read-only API keys (WC_CONSUMER_KEY / WC_CONSUMER_SECRET): real stock quantities.
// WITHOUT them (or if they fail): the public Store API gives "In stock" / "Sold Out" only.
const STORE = (process.env.STORE_URL || "https://dealy.co.za").replace(/\/$/, "");
const KEY = process.env.WC_CONSUMER_KEY || "";
const SECRET = process.env.WC_CONSUMER_SECRET || "";
const HAS_KEYS = Boolean(KEY && SECRET);

// Quantities above this show as "20+" so exact warehouse numbers stay private. 0 = always show exact.
const CAP_RAW = process.env.STOCK_CAP;
const STOCK_CAP = CAP_RAW === undefined || CAP_RAW === "" || Number.isNaN(Number(CAP_RAW)) ? 20 : Number(CAP_RAW);

// Sending keys in the URL can leak them into host/proxy logs, so it is OFF unless you opt in (WC_ALLOW_QUERY_AUTH=1).
const ALLOW_QUERY_AUTH = process.env.WC_ALLOW_QUERY_AUTH === "1";

// Global safety valve: max uncached product lookups per minute across ALL visitors.
const MAX_LOOKUPS_PER_MIN = Number(process.env.MAX_PRODUCT_LOOKUPS_PER_MIN) || 40;
let budgetStart = 0;
let budgetUsed = 0;
function lookupAllowed() {
  const now = Date.now();
  if (now - budgetStart >= 60_000) { budgetStart = now; budgetUsed = 0; }
  if (budgetUsed >= MAX_LOOKUPS_PER_MIN) return false;
  budgetUsed++;
  return true;
}

const CACHE_MS = 30_000;
const cache = new Map();

export const productTool = {
  type: "function",
  function: {
    name: "search_products",
    description:
      "Search the Dealy online store. Returns product names, SKUs, prices, condition (demo model, clearance stock or new), stock status and stock quantities " +
      "(when available), plus links. Use for any question about a specific product, price, stock levels, " +
      "availability, or a product recommendation.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Short search keywords, e.g. 'office chair', 'projector', 'tv stand'"
        }
      },
      required: ["query"]
    }
  }
};

const clean = (s = "") =>
  String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();


// Dealy sells demo and clearance stock, so pull the condition out of the categories.
const CONDITIONS = ["demo model", "clearance stock", "new"];
function splitCats(list) {
  const names = (list ?? []).map((c) => clean(c.name)).filter(Boolean);
  return {
    condition: names.filter((n) => CONDITIONS.includes(n.toLowerCase())),
    category: names.filter((n) => !CONDITIONS.includes(n.toLowerCase())).slice(0, 2)
  };
}

const rand = (n) => (n == null || n === "" || Number.isNaN(Number(n)) ? null : `R${Number(n).toFixed(2).replace(".", ",")}`);
// Store API prices are in minor units (cents): "1099900" => R10999,00 (the website's style)
const fromMinor = (minor, unit = 2) => (minor == null || minor === "" ? null : rand(Number(minor) / 10 ** unit));

const stockLabel = (status) =>
  status === "instock" ? "In stock" : status === "onbackorder" ? "Available on backorder" : "Sold Out";

function stockInfo({ status, managed, qty }) {
  const info = { stock: stockLabel(status) };
  if (managed && qty != null && !Number.isNaN(Number(qty))) {
    const n = Math.max(0, Number(qty));
    info.stock_quantity = STOCK_CAP > 0 && n > STOCK_CAP ? `${STOCK_CAP}+` : n;
  }
  return info;
}

/* ---------- WooCommerce REST API (real quantities, needs keys) ---------- */

async function wcFetch(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${STORE}/wp-json/wc/v3/${path}`;
  const basic = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");

  let res = await fetch(`${url}?${qs}`, {
    signal: AbortSignal.timeout(6000),
    headers: { Accept: "application/json", Authorization: basic }
  });

  // Optional fallback for hosts that strip the Authorization header. Off by default (keys in URLs can be logged).
  if ((res.status === 401 || res.status === 403) && ALLOW_QUERY_AUTH && STORE.startsWith("https://")) {
    qs.set("consumer_key", KEY);
    qs.set("consumer_secret", SECRET);
    res = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" } });
  }

  if (!res.ok) throw new Error(`WooCommerce API returned ${res.status}`);
  return res.json();
}

function shapeWc(p, variations) {
  const out = {
    name: clean(p.name),
    sku: p.sku || undefined,
    price: rand(p.price),
    ...stockInfo({ status: p.stock_status, managed: p.manage_stock, qty: p.stock_quantity }),
    url: p.permalink
  };
  if (p.on_sale && p.regular_price && p.regular_price !== p.price) out.was = rand(p.regular_price);
  const { condition, category } = splitCats(p.categories);
  if (condition.length) out.condition = condition.join(", ");
  if (category.length) out.category = category.join(", ");
  const summary = clean(p.short_description).slice(0, 200);
  if (summary) out.summary = summary;

  if (Array.isArray(variations) && variations.length) {
    out.options = variations.slice(0, 8).map((v) => ({
      option: (v.attributes ?? []).map((a) => clean(a.option)).filter(Boolean).join(", ") || v.sku || `#${v.id}`,
      price: rand(v.price),
      ...stockInfo({ status: v.stock_status, managed: v.manage_stock, qty: v.stock_quantity })
    }));
  }
  return out;
}

async function findWithStock(q) {
  const items = await wcFetch("products", { search: q, per_page: "5", status: "publish" });
  if (!Array.isArray(items)) throw new Error("Unexpected WooCommerce response");

  // Look up options (e.g. colours) for the first 3 variable products, wherever they rank.
  const withOptions = new Set(items.filter((p) => p.type === "variable").slice(0, 3).map((p) => p.id));

  return Promise.all(
    items.map(async (p) => {
      let variations;
      if (withOptions.has(p.id)) {
        try { variations = await wcFetch(`products/${p.id}/variations`, { per_page: "10" }); }
        catch (err) { console.error("VARIATION LOOKUP ERROR:", err.message); }
      }
      return shapeWc(p, variations);
    })
  );
}

/* ---------- public Store API (status only, no keys) ---------- */

async function fetchStoreApi(q) {
  const url = `${STORE}/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=5`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Store returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Unexpected store response");
  return data;
}

function shapeStore(p) {
  const pr = p.prices ?? {};
  const unit = pr.currency_minor_unit ?? 2;
  const out = { name: clean(p.name), price: fromMinor(pr.price, unit), stock: p.is_in_stock ? "In stock" : "Sold Out", url: p.permalink };
  // WooCommerce only reports a count here when stock is running low
  if (p.is_in_stock && Number.isInteger(p.low_stock_remaining)) out.stock_quantity = p.low_stock_remaining;
  if (p.on_sale && pr.regular_price && pr.regular_price !== pr.price) out.was = fromMinor(pr.regular_price, unit);
  const { condition, category } = splitCats(p.categories);
  if (condition.length) out.condition = condition.join(", ");
  if (category.length) out.category = category.join(", ");
  const summary = clean(p.short_description).slice(0, 200);
  if (summary) out.summary = summary;
  return out;
}

/* ---------- search ---------- */

async function findProducts(q) {
  if (HAS_KEYS) {
    try {
      return await findWithStock(q);
    } catch (err) {
      console.error("WOOCOMMERCE API ERROR (using public store data instead):", err.message);
    }
  }
  return (await fetchStoreApi(q)).map(shapeStore);
}

export async function searchProducts({ query } = {}) {
  const q = String(query ?? "").trim().slice(0, 80);
  if (!q) return { error: "No search terms given." };

  const searchUrl = `${STORE}/?s=${encodeURIComponent(q)}&post_type=product`;
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  if (!lookupAllowed()) {
    return { error: "Live product search is busy right now. Please try again in a minute.", search_link: searchUrl };
  }

  try {
    let products = await findProducts(q);

    // Multi-word searches can come back empty; retry with the longest word.
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    if (!products.length && words.length > 1) {
      products = await findProducts([...words].sort((a, b) => b.length - a.length)[0]);
    }

    const result = { query: q, count: products.length, products, more_results_link: searchUrl };
    if (!products.length) result.note = "No matching products found.";

    if (cache.size > 200) cache.clear();
    cache.set(key, { t: Date.now(), v: result });
    return result;
  } catch (err) {
    console.error("PRODUCT SEARCH ERROR:", err.message);
    return { error: "Live product search is temporarily unavailable.", search_link: searchUrl };
  }
}
