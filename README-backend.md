# PipNex Flow backend

Secure Node.js/Express proxy for SiftingIO market data.

## Render settings
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `SIFTING_API_KEY` = your private SiftingIO key

## Routes
- `GET /` service status
- `GET /api/health` checks whether a key is configured without revealing it
- `GET /api/market/:venue/:symbol` proxies a SiftingIO last-trade request

Supported venues: `forex`, `crypto`, `commodities`, `stocks`, `dex`.

Never put the API key in frontend code, GitHub, or chat.
