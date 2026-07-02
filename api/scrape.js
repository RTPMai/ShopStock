export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const adminKey = process.env.ADMIN_KEY;

  if(req.headers["x-admin-key"] !== adminKey && req.query.secret !== adminKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${kvToken}` } });
    const j = await r.json();
    if(!j.result) return null;
    let val = j.result;
    for(let i=0;i<3;i++){ if(typeof val==="string"){ try{ val=JSON.parse(val); }catch(e){ break; } } else break; }
    return val;
  }

  async function kvSet(key, value) {
    await fetch(`${kvUrl}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value)]])
    });
  }

  // Price extraction patterns for common suppliers
  function extractPrice(html, url) {
    const patterns = [
      // Generic structured data (works on most sites)
      /"price"\s*:\s*"?([\d,]+\.?\d*)"?/i,
      /"offers"\s*:\s*\{[^}]*"price"\s*:\s*"?([\d,]+\.?\d*)"?/i,
      // Meta tags
      /property="product:price:amount"\s+content="([\d,]+\.?\d*)"/i,
      /property="og:price:amount"\s+content="([\d,]+\.?\d*)"/i,
      // Common price class patterns
      /class="[^"]*price[^"]*"[^>]*>\$?\s*([\d,]+\.?\d*)/i,
      /itemprop="price"[^>]*content="([\d,]+\.?\d*)"/i,
      /data-price="([\d,]+\.?\d*)"/i,
      // Amazon specific
      /priceAmount":\s*"([\d.]+)"/i,
      // Uline specific
      /"salePrice":"([\d.]+)"/i,
      // SPSI / generic
      /\$\s*([\d,]+\.\d{2})\s*(?:\/|per|each)/i,
    ];

    for(const pattern of patterns) {
      const match = html.match(pattern);
      if(match) {
        const price = parseFloat(match[1].replace(/,/g, ""));
        if(price > 0 && price < 100000) return price;
      }
    }
    return null;
  }

  async function scrapePrice(url) {
    if(!url || url.startsWith("email") || url.startsWith("EMAIL")) return { price: null, reason: "email-based supplier" };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        }
      });
      clearTimeout(timeout);
      if(!r.ok) return { price: null, reason: `HTTP ${r.status}` };
      const html = await r.text();
      const price = extractPrice(html, url);
      if(price) return { price, reason: "scraped" };
      return { price: null, reason: "price not found on page" };
    } catch(e) {
      return { price: null, reason: e.message };
    }
  }

  // Scrape a single item by ID — also checks alternate vendor links for comparison
  if(req.query.id) {
    const item = await kvGet(`supply_item_${req.query.id}`);
    if(!item) return res.status(404).json({ error: "Item not found" });

    // Scrape the primary supplier link (this is the only one that can auto-update currentPrice)
    const result = await scrapePrice(item.supplierLink);
    let primaryUpdated = false;
    if(result.price && result.price !== item.currentPrice) {
      item.priceHistory = item.priceHistory || [];
      item.priceHistory.push({ price: result.price, supplier: item.supplier, date: new Date().toISOString(), source: "auto-scraped" });
      item.currentPrice = result.price;
      primaryUpdated = true;
    }
    item.lastScraped = new Date().toISOString();

    // Scrape alternate vendors — comparison only, never touches currentPrice automatically
    item.altVendors = Array.isArray(item.altVendors) ? item.altVendors : [];
    for(const v of item.altVendors) {
      const vResult = await scrapePrice(v.supplierLink);
      if(vResult.price != null) v.lastPrice = vResult.price;
      v.lastScraped = new Date().toISOString();
      v.lastScrapeReason = vResult.reason;
      await new Promise(r => setTimeout(r, 400));
    }

    item.updatedAt = new Date().toISOString();
    await kvSet(`supply_item_${item.id}`, item);

    // Figure out the cheapest option across primary + alt vendors
    const options = [
      { supplier: item.supplier, price: item.currentPrice, link: item.supplierLink, isPrimary: true },
      ...item.altVendors
        .filter(v => v.lastPrice != null)
        .map(v => ({ supplier: v.supplier, price: v.lastPrice, link: v.supplierLink, isPrimary: false, id: v.id })),
    ].filter(o => o.price != null && o.price > 0);
    options.sort((a, b) => a.price - b.price);
    const cheapest = options[0] || null;
    const isCheaperElsewhere = !!(cheapest && !cheapest.isPrimary && cheapest.price < item.currentPrice);

    return res.status(200).json({
      updated: primaryUpdated,
      newPrice: primaryUpdated ? item.currentPrice : null,
      reason: result.reason,
      item,
      cheapest,
      isCheaperElsewhere,
    });
  }

  // Scrape all items
  const index = await kvGet("supply_index") || [];
  const results = [];
  let updated = 0;
  let failed = 0;

  for(const id of index) {
    const item = await kvGet(`supply_item_${id}`);
    if(!item || !item.supplierLink) { failed++; continue; }
    const result = await scrapePrice(item.supplierLink);
    if(result.price && result.price !== item.currentPrice) {
      item.priceHistory = item.priceHistory || [];
      item.priceHistory.push({ price: result.price, supplier: item.supplier, date: new Date().toISOString(), source: "auto-scraped" });
      item.currentPrice = result.price;
      item.lastScraped = new Date().toISOString();
      item.updatedAt = new Date().toISOString();
      await kvSet(`supply_item_${item.id}`, item);
      updated++;
      results.push({ id, name: item.name, updated: true, newPrice: result.price });
    } else {
      item.lastScraped = new Date().toISOString();
      await kvSet(`supply_item_${item.id}`, item);
      failed += result.price ? 0 : 1;
      results.push({ id, name: item.name, updated: false, reason: result.reason });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return res.status(200).json({ ok: true, total: index.length, updated, failed, results, scrapedAt: new Date().toISOString() });
}
