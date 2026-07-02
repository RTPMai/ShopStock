export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  if(req.method === "OPTIONS") return res.status(200).end();

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const adminKey = process.env.ADMIN_KEY;

  if(!kvUrl || !kvToken) return res.status(500).json({ error: "Upstash not configured" });

  function isAdmin() {
    return req.headers["x-admin-key"] === adminKey;
  }

  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const j = await r.json();
    if(!j.result) return null;
    let val = j.result;
    for(let i=0;i<3;i++){
      if(typeof val==="string"){ try{ val=JSON.parse(val); }catch(e){ break; } } else break;
    }
    return val;
  }

  async function kvSet(key, value) {
    await fetch(`${kvUrl}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value)]])
    });
  }

  async function getAll() {
    const index = await kvGet("supply_index") || [];
    const items = await Promise.all(index.map(id => kvGet(`supply_item_${id}`)));
    return items.filter(Boolean);
  }

  // GET all items
  if(req.method === "GET" && !req.query.id) {
    const items = await getAll();
    return res.status(200).json(items);
  }

  // GET single item
  if(req.method === "GET" && req.query.id) {
    const item = await kvGet(`supply_item_${req.query.id}`);
    if(!item) return res.status(404).json({ error: "Item not found" });
    return res.status(200).json(item);
  }

  // POST — create item (admin only)
  if(req.method === "POST") {
    if(!isAdmin()) return res.status(401).json({ error: "Unauthorized" });
    const body = req.body;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const item = {
      id,
      name: body.name,
      department: body.department || "",
      category: body.category || "",
      supplier: body.supplier || "",
      supplierLink: body.supplierLink || "",
      unit: body.unit || "",
      currentPrice: parseFloat(body.currentPrice) || 0,
      priceHistory: body.currentPrice ? [{ price: parseFloat(body.currentPrice), supplier: body.supplier, date: new Date().toISOString() }] : [],
      altVendors: Array.isArray(body.altVendors) ? body.altVendors.map(v => ({
        id: v.id || ("v" + Math.random().toString(36).slice(2, 8)),
        supplier: v.supplier || "",
        supplierLink: v.supplierLink || "",
        lastPrice: v.lastPrice != null && v.lastPrice !== "" ? parseFloat(v.lastPrice) : null,
        lastScraped: v.lastScraped || null,
      })) : [],
      status: body.status || "In Stock",
      lastOrdered: null,
      timesOrderedYTD: 0,
      notes: body.notes || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await kvSet(`supply_item_${id}`, item);
    const index = await kvGet("supply_index") || [];
    index.push(id);
    await kvSet("supply_index", index);
    return res.status(201).json(item);
  }

  // PUT — update item
  if(req.method === "PUT") {
    if(!req.query.id) return res.status(400).json({ error: "Missing id" });
    const item = await kvGet(`supply_item_${req.query.id}`);
    if(!item) return res.status(404).json({ error: "Item not found" });

    const body = req.body;
    const isAdminReq = isAdmin();

    // Staff can only flag status
    if(!isAdminReq) {
      if(body.action === "flag") {
        item.status = "Needs Ordered";
        item.updatedAt = new Date().toISOString();
        await kvSet(`supply_item_${item.id}`, item);
        // Notify via email
        await notifyAdmin(item);
        return res.status(200).json(item);
      }
      if(body.action === "issue") {
        item.status = "In Stock";
        item.lastOrdered = new Date().toISOString();
        item.timesOrderedYTD = (item.timesOrderedYTD || 0) + 1;
        item.updatedAt = new Date().toISOString();
        await kvSet(`supply_item_${item.id}`, item);
        return res.status(200).json(item);
      }
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Admin full update
    if(body.currentPrice && parseFloat(body.currentPrice) !== item.currentPrice) {
      item.priceHistory = item.priceHistory || [];
      item.priceHistory.push({ price: parseFloat(body.currentPrice), supplier: body.supplier || item.supplier, date: new Date().toISOString() });
    }
    Object.assign(item, {
      name: body.name ?? item.name,
      department: body.department ?? item.department,
      category: body.category ?? item.category,
      supplier: body.supplier ?? item.supplier,
      supplierLink: body.supplierLink ?? item.supplierLink,
      unit: body.unit ?? item.unit,
      currentPrice: body.currentPrice ? parseFloat(body.currentPrice) : item.currentPrice,
      status: body.status ?? item.status,
      notes: body.notes ?? item.notes,
      altVendors: Array.isArray(body.altVendors) ? body.altVendors.map(v => ({
        id: v.id || ("v" + Math.random().toString(36).slice(2, 8)),
        supplier: v.supplier || "",
        supplierLink: v.supplierLink || "",
        lastPrice: v.lastPrice != null && v.lastPrice !== "" ? parseFloat(v.lastPrice) : null,
        lastScraped: v.lastScraped || null,
      })) : (item.altVendors || []),
      updatedAt: new Date().toISOString(),
    });
    if(body.status === "Ordered") item.lastOrdered = new Date().toISOString();
    if(body.status === "In Stock" && item.status === "Ordered") item.timesOrderedYTD = (item.timesOrderedYTD||0)+1;
    await kvSet(`supply_item_${item.id}`, item);
    return res.status(200).json(item);
  }

  // DELETE item (admin only) — supports ?all=true to wipe every item (for clean re-imports)
  if(req.method === "DELETE") {
    if(!isAdmin()) return res.status(401).json({ error: "Unauthorized" });
    if(req.query.all === "true") {
      const index = await kvGet("supply_index") || [];
      for(const id of index) {
        await fetch(`${kvUrl}/del/supply_item_${id}`, { method: "POST", headers: { Authorization: `Bearer ${kvToken}` } });
      }
      await kvSet("supply_index", []);
      return res.status(200).json({ ok: true, deleted: index.length });
    }
    if(!req.query.id) return res.status(400).json({ error: "Missing id" });
    const index = (await kvGet("supply_index") || []).filter(i => i !== req.query.id);
    await kvSet("supply_index", index);
    await fetch(`${kvUrl}/del/supply_item_${req.query.id}`, { method: "POST", headers: { Authorization: `Bearer ${kvToken}` } });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function notifyAdmin(item) {
  // Email notification via simple fetch to notify endpoint
  const notifyUrl = process.env.NOTIFY_URL;
  if(!notifyUrl) return;
  try {
    await fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: item.name, department: item.department, status: item.status })
    });
  } catch(e) {}
}
