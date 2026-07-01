export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  if(req.method === "OPTIONS") return res.status(200).end();

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const adminKey = process.env.ADMIN_KEY;

  if(!kvUrl || !kvToken) return res.status(500).json({ error: "Upstash not configured" });

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

  // GET — return all settings
  if(req.method === "GET") {
    const deptColors = await kvGet("ss_dept_colors") || {
      "Screen Printing": "#FB8C00",
      "Embroidery":      "#8E24AA",
      "Office":          "#1E88E5",
      "General":         "#43A047",
      "Heat Seal":       "#E91E63",
      "Compiling":       "#00ACC1",
      "DTF":             "#FFB300",
      "Promo Products":  "#7CB342",
    };
    const categories = await kvGet("ss_categories") || [
      "Inks","Chemicals","Tools","Tape","Emulsion","Thread","Stabilizer",
      "Consumables","Safety","Packaging","Paper","Electronics","Pens & Markers","Cleaning","Vinyl"
    ];
    return res.status(200).json({ deptColors, categories });
  }

  // POST — save settings (admin only)
  if(req.method === "POST") {
    if(req.headers["x-admin-key"] !== adminKey) return res.status(401).json({ error: "Unauthorized" });
    const { deptColors, categories } = req.body;
    if(deptColors) await kvSet("ss_dept_colors", deptColors);
    if(categories) await kvSet("ss_categories", categories);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
