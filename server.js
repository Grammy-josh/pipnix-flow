const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: process.env.APP_ORIGIN || "*", methods: ["GET"] }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

const venues = new Set(["forex", "crypto", "commodities", "stocks", "dex"]);
const symbolPattern = /^[A-Za-z0-9]{6,12}$/;

app.get("/", (_req, res) => res.json({
  service: "PipNex Flow API",
  status: "online",
  marketData: process.env.SIFTING_API_KEY ? "configured" : "not_configured"
}));

app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  marketDataConfigured: Boolean(process.env.SIFTING_API_KEY)
}));

app.get("/api/market/:venue/:symbol", async (req, res) => {
  try {
    const venue = String(req.params.venue || "").toLowerCase();
    const symbol = String(req.params.symbol || "").toUpperCase();
    if (!venues.has(venue)) return res.status(400).json({ error: "Unsupported market venue" });
    if (!symbolPattern.test(symbol)) return res.status(400).json({ error: "Invalid symbol format" });
    if (!process.env.SIFTING_API_KEY) return res.status(503).json({ error: "Market data is not configured" });

    const url = `https://api.sifting.io/v1/last/trade/${encodeURIComponent(venue)}/${encodeURIComponent(symbol)}`;
    const upstream = await fetch(url, {
      headers: { "X-API-Key": process.env.SIFTING_API_KEY },
      signal: AbortSignal.timeout(15000)
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 1000) }; }
    if (!upstream.ok) return res.status(upstream.status).json({
      error: "Market data provider request failed",
      providerStatus: upstream.status,
      details: data
    });
    res.set("Cache-Control", "no-store");
    return res.json({ venue, symbol, provider: "SiftingIO", retrievedAt: new Date().toISOString(), data });
  } catch (err) {
    const timeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? "Market data provider timed out" : "Unable to reach market data provider"
    });
  }
});

app.listen(PORT, () => console.log(`PipNex Flow API listening on ${PORT}`));
