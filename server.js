
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

const AI_MODEL = "gemini-3.5-flash-lite";

// Render proxy configuration
app.set("trust proxy", 1);

// Security
app.use(helmet());

app.use(cors({
  origin: process.env.APP_ORIGIN || "*",
  methods: ["GET", "POST"]
}));

app.use(express.json({ limit: "1mb" }));

// General API rate limit
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

// Chart AI protection: 3 requests per minute
const chartLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Chart AI limit reached. Please wait one minute."
  }
});

// Supported market venues
const venues = new Set([
  "forex",
  "crypto",
  "commodities",
  "stocks",
  "dex"
]);

const symbolPattern = /^[A-Za-z0-9]{6,12}$/;

// Image upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(
        "Only JPEG, PNG and WebP images are allowed"
      ));
    }
  }
});

// API home
app.get("/", (_req, res) => {
  res.json({
    service: "PipNex Flow API",
    status: "online",
    marketData: process.env.SIFTING_API_KEY
      ? "configured"
      : "not_configured",
    chartAI: process.env.GEMINI_API_KEY
      ? "configured"
      : "not_configured"
  });
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    marketDataConfigured: Boolean(
      process.env.SIFTING_API_KEY
    ),
    chartAIConfigured: Boolean(
      process.env.GEMINI_API_KEY
    )
  });
});

// Market data
app.get("/api/market/:venue/:symbol", async (req, res) => {
  try {
    const venue = String(
      req.params.venue || ""
    ).toLowerCase();

    const symbol = String(
      req.params.symbol || ""
    ).toUpperCase();

    if (!venues.has(venue)) {
      return res.status(400).json({
        error: "Unsupported market venue"
      });
    }

    if (!symbolPattern.test(symbol)) {
      return res.status(400).json({
        error: "Invalid symbol format"
      });
    }

    if (!process.env.SIFTING_API_KEY) {
      return res.status(503).json({
        error: "Market data is not configured"
      });
    }

    const url =
      `https://api.sifting.io/v1/last/trade/${encodeURIComponent(venue)}/${encodeURIComponent(symbol)}`;

    const upstream = await fetch(url, {
      headers: {
        "X-API-Key": process.env.SIFTING_API_KEY
      },
      signal: AbortSignal.timeout(15000)
    });

    const raw = await upstream.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = {
        message: raw.slice(0, 1000)
      };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Market data provider request failed",
        providerStatus: upstream.status,
        details: data
      });
    }

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

// Chart AI analysis
app.post(
  "/api/chart/analyze",
  chartLimiter,
  upload.single("chart"),
  async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({
          error: "Chart AI is not configured"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Please upload a chart image"
        });
      }

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
      });

      const base64Image =
        req.file.buffer.toString("base64");

      const prompt = `
You are PipNex Flow, a careful educational trading chart analyst.

Your task is to analyse ONLY the information visible in the uploaded chart.

Do not assume that the chart is live.
Do not assume the current market price.
Do not assume a symbol or timeframe if it is not visible.

FIRST, inspect the image:
- Identify the market symbol and timeframe only if readable.
- Check whether the chart is clear enough to analyse.
- Identify visible candles, price action, and indicators.
- If the chart is cropped, blurry, or missing important information, explain this.

IMPORTANT ANALYSIS RULES:

1. Never invent prices, candles, indicators, support, resistance,
   entry levels, stop losses, or targets.

2. Clearly distinguish visible chart information from your own
   technical interpretation.

3. If the price scale is unreadable, do not manufacture exact
   numerical entry, stop-loss, or take-profit levels.

4. Do not force a BUY or SELL setup simply because the user
   uploaded a chart.

5. If evidence is weak, conflicting, or incomplete, the final
   decision must be WAIT / NO TRADE.

6. Never guarantee profits or claim that a setup will win.

7. Never recommend increasing lot size, using excessive leverage,
   or risking money the trader cannot afford to lose.

8. All entry, stop-loss and take-profit levels are hypothetical
   educational estimates based on the uploaded image only.

9. Do not claim to have checked live market prices, news,
   economic events, or broker spreads.

10. Do not execute trades or instruct automatic execution.

USE THIS EXACT RESPONSE STRUCTURE:

### 1. CHART INFORMATION
- Market:
- Timeframe:
- Chart clarity:
- Visible indicators:

Use "Not identifiable" when information cannot be read.

### 2. MARKET DIRECTION
Explain whether the visible market appears bullish, bearish,
or sideways. Explain the evidence.

### 3. MARKET STRUCTURE
Describe visible higher highs, higher lows, lower highs,
lower lows, breakouts, or consolidation where identifiable.

Do not invent structure that cannot be seen.

### 4. SUPPORT AND RESISTANCE
Identify visible support and resistance areas.

Use exact prices only when the chart scale makes them readable.
Otherwise describe approximate zones without inventing numbers.

### 5. POSSIBLE TRADE SETUP
Choose one:

- BUY BIAS
- SELL BIAS
- WAIT / NO TRADE

Explain why.

Only describe a possible BUY or SELL setup when there is
reasonable visible evidence.

### 6. POSSIBLE ENTRY ZONE
Give a hypothetical entry zone only if the chart provides
enough readable price information.

Explain what price behaviour would make the entry valid.

If there is insufficient information, write:
"Entry zone unavailable - more information required."

### 7. STOP LOSS
Suggest a hypothetical invalidation area only when it can
reasonably be identified from the chart.

Explain why the setup would be invalidated there.

Never invent an exact price.

### 8. TAKE PROFIT
Suggest possible target areas only when supported by visible
structure, support, resistance, or other readable chart evidence.

Do not promise that price will reach them.

### 9. ENTRY CONFIRMATION
Explain what the trader should wait to see before considering
the hypothetical setup.

Examples may include:
- Candle close confirmation.
- Break and retest.
- Rejection from a visible level.
- A clear change in market structure.

Only include conditions relevant to the uploaded chart.

### 10. SETUP INVALIDATION
Explain what price action would cancel the possible setup.

### 11. RISK CHECK
Explain the importance of:
- Position sizing.
- Stop-loss placement.
- Risk-to-reward.
- Avoiding emotional entries.
- Demo testing before risking real money.

Do not prescribe a lot size without account balance,
instrument specifications, and risk information.

### 12. FINAL DECISION
Choose exactly one:

BUY BIAS
SELL BIAS
WAIT / NO TRADE

Give a short explanation.

If the chart does not provide sufficient evidence,
choose WAIT / NO TRADE.

FINAL REMINDER:

This is educational chart analysis, not financial advice.
The uploaded image may be delayed or incomplete.
Always independently verify prices and conditions on the
trading platform before making any decision.
`;

      const result = await ai.models.generateContent({
        model: AI_MODEL,
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

      if (!analysis) {
        return res.status(502).json({
          error: "AI returned an empty analysis"
        });
      }

      return res.json({
        success: true,
        model: AI_MODEL,
        analysis,
        disclaimer:
          "Educational analysis only. Entry, stop-loss and take-profit levels are hypothetical estimates from the uploaded chart, not guaranteed trading signals. Verify independently."
      });

    } catch (err) {
      console.error(
        "Chart AI error:",
        err.message
      );

      return res.status(500).json({
        error:
          "Chart analysis failed. Try again later or check AI configuration."
      });
    }
  }
);

// Upload and server error handling
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE"
        ? "Image exceeds the 5MB limit"
        : "Image upload failed"
    });
  }

  if (
    err.message &&
    err.message.startsWith("Only JPEG")
  ) {
    return res.status(400).json({
      error: err.message
    });
  }

  console.error("Server error:", err.message);

  return res.status(500).json({
    error: "Server error"
  });
});

// Start server
app.listen(PORT, () => {
  console.log(
    `PipNex Flow API listening on ${PORT}`
  );
});
