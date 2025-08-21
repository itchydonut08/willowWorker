# Willow Forecasts Worker — Financial Only (Path 2)

This Worker scrapes **financial** markets from Polymarket & Kalshi (via `r.jina.ai`) once per day, freezes a snapshot in **KV** keyed by `YYYY-MM-DD`, and serves it at **`GET /api/forecasts`** with CORS enabled. If scraping fails, it emits a deterministic, date‑seeded **financial** set so everyone sees the same list for that day.

## Step‑by‑step

1) **Add these files to your repo**
```
/wrangler.toml
/src/worker.js
```

2) **Create KV (one‑time)**
```bash
npx wrangler kv namespace create willow-forecasts
```
Copy `id` and `preview_id` into `wrangler.toml` under `[[kv_namespaces]]`.

3) **Login & deploy**
```bash
npx wrangler login
npx wrangler deploy
```
This deploys and enables a **cron** at 13:00 UTC (defined in `wrangler.toml`).

4) **Verify**
```bash
curl https://<your-worker>.workers.dev/api/forecasts
# => { "date": "YYYY-MM-DD", "items": [ { "source":"Polymarket","title":"...", "probability": 63 }, ... ] }
```

5) **Frontend integration**
Replace any client-side scraping with:
```js
const r = await fetch('/api/forecasts', { cache: 'no-store' });
const { date, items } = await r.json();
// render items
```
If your Worker is on a different subdomain, use its full URL.

## Only financial forecasts
The worker uses a simple keyword allow/deny list to filter titles:
- Include (examples): CPI, inflation, PCE, GDP, unemployment, Fed, rate/hike/cut,
  Treasury/bond/yield, S&P/Nasdaq/Dow, earnings, credit/CRE/bank, mortgage/housing,
  WTI/Brent/oil, gold/silver/copper, FX pairs, Bitcoin/Ethereum, VIX/volatility.
- Exclude (examples): elections, sports, entertainment, weather.

You can tweak these lists in `FINANCE_INCLUDE` / `FINANCE_EXCLUDE` near the top of `worker.js`.

## Tuning & Notes
- **Cron time**: edit in `wrangler.toml` (e.g., `0 09 * * *` for 09:00 UTC).
- **Retention**: snapshots live 14 days; change `expirationTtl` in `worker.js`.
- **Retries**: the fetch includes light retries with jitter; you can increase them.
- **CORS**: currently `*` for easy consumption. Restrict if needed.
