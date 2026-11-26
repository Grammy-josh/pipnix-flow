
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({
  origin: process.env.APP_ORIGIN || "*",
  methods: ["GET", "POST"]
}));
app.use(express.json({ limit: "1mb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

const venues = new Set(["forex", "crypto", "commodities", "stocks", "dex"]);
const symbolPattern = /^[A-Za-z0-9]{6,12}$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG and WebP images are allowed"));
    }
  }
});

app.get("/", (_req, res) => res.json({
  service: "PipNex Flow API",
  status: "online",
  marketData: process.env.SIFTING_API_KEY ? "configured" : "not_configured",
  chartAI: process.env.GEMINI_API_KEY ? "configured" : "not_configured"
}));

app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  marketDataConfigured: Boolean(process.env.SIFTING_API_KEY),
  chartAIConfigured: Boolean(process.env.GEMINI_API_KEY)
}));

// Market data
app.get("/api/market/:venue/:symbol", async (req, res) => {
  try {
    const venue = String(req.params.venue || "").toLowerCase();
    const symbol = String(req.params.symbol || "").toUpperCase();

    if (!venues.has(venue))
      return res.status(400).json({ error: "Unsupported market venue" });

    if (!symbolPattern.test(symbol))
      return res.status(400).json({ error: "Invalid symbol format" });

    if (!process.env.SIFTING_API_KEY)
      return res.status(503).json({ error: "Market data is not configured" });

    const url = `https://api.sifting.io/v1/last/trade/${encodeURIComponent(venue)}/${encodeURIComponent(symbol)}`;

    const upstream = await fetch(url, {
      headers: { "X-API-Key": process.env.SIFTING_API_KEY },
      signal: AbortSignal.timeout(15000)
    });

    const raw = await upstream.text();
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw.slice(0, 1000) };
    }

    if (!upstream.ok)
      return res.status(upstream.status).json({
        error: "Market data provider request failed",
        providerStatus: upstream.status,
        details: data
      });

    res.set("Cache-Control", "no-store");

    return res.json({
      venue,
      symbol,
      provider: "SiftingIO",
      retrievedAt: new Date().toISOString(),
      data
    });

  } catch (err) {
    const timeout = err && (
      err.name === "TimeoutError" ||
      err.name === "AbortError"
    );

    return res.status(timeout ? 504 : 502).json({
      error: timeout
        ? "Market data provider timed out"
        : "Unable to reach market data provider"
    });
  }
});

// Chart AI
app.post("/api/chart/analyze", upload.single("chart"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY)
      return res.status(503).json({
        error: "Chart AI is not configured"
      });

    if (!req.file)
      return res.status(400).json({
        error: "Please upload a chart image"
      });

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    const base64Image = req.file.buffer.toString("base64");

    const prompt = `
You are PipNex Flow Chart Analyst.

Analyse the uploaded trading chart image for educational purposes.

Explain:
1. Market direction visible in the chart.
2. Market structure.
3. Support and resistance areas that are actually visible.
4. Possible setups, if any.
5. What would invalidate a possible setup.
6. Risk considerations.
7. Whether the chart is unclear or missing information.

Do not invent prices, indicators or chart details.
If no clear setup exists, say NO CLEAR SETUP.
Do not guarantee outcomes.
Do not instruct automatic trade execution.
Use cautious, clear language.

Format your response with headings and concise explanations.
`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [
        { text: prompt },
        {
          inlineData: {
            mimeType: req.file.mimetype,
            data: base64Image
          }
        }
      ]
    });

    const analysis = result.text;

    if (!analysis)
      return res.status(502).json({
        error: "AI returned an empty analysis"
      });

    return res.json({
      success: true,
      model: "gemini-2.5-flash-lite",
      analysis,
      disclaimer: "Educational analysis only. AI can be wrong. Verify all observations independently."
    });

  } catch (err) {
    console.error("Chart AI error:", err.message);

    return res.status(500).json({
      error: "Chart analysis failed. Try again later or check AI configuration."
    });
  }
});

// Upload error handling
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE"
        ? "Image exceeds the 5MB limit"
        : "Image upload failed"
    });
  }

  if (err.message && err.message.startsWith("Only JPEG")) {
    return res.status(400).json({ error: err.message });
  }

  console.error("Server error:", err.message);

  return res.status(500).json({
    error: "Server error"
  });
});

app.listen(PORT, () => {
  console.log(`PipNex Flow API listening on ${PORT}`);
});
  
