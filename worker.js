// Cloudflare Worker: daily FINANCIAL forecasts (Polymarket + Kalshi via r.jina.ai)
// - Runs daily on cron, freezes the snapshot under YYYY-MM-DD in KV
// - Filters to FINANCIAL forecasts with simple keyword heuristics
// - Serves JSON at GET /api/forecasts  (CORS enabled)
// - Fallback: deterministic, date-seeded list (finance only)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (url.pathname === "/api/forecasts") {
      const date = url.searchParams.get("date") || utcDate();
      const force = url.searchParams.get("force") === "1";

      if (!force) {
        const cached = await env.FORECASTS.get(date, "json");
        if (cached) return cors(json({ date, items: cached }));
      }

      const items = await generateForDay(env, date);
      return cors(json({ date, items }));
    }

    return cors(new Response("OK", { status: 200 }));
  },

  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(generateForDay(env, utcDate()).catch(console.error));
  }
};

const POLY_URL   = "https://r.jina.ai/http://polymarket.com/markets";
const KALSHI_URL = "https://r.jina.ai/http://kalshi.com/markets";
const MAX_ITEMS  = 20; // global cap after filtering

/* ================= Utils ================= */
function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function json(o) { return new Response(JSON.stringify(o), { headers:{ "content-type":"application/json; charset=utf-8" } }); }
function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin","*");
  h.set("Access-Control-Allow-Headers","*");
  h.set("Access-Control-Allow-Methods","GET,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}

// tiny retry with jitter
async function fetchText(url, tries=3) {
  let last;
  for (let i=0;i<tries;i++){
    try {
      const r = await fetch(url, { cf:{ cacheTtl:0, cacheEverything:false }, headers:{ "user-agent":"Mozilla/5.0 WillowForecastBot/1.0" } });
      if(!r.ok) throw new Error("HTTP "+r.status);
      return await r.text();
    } catch (e) {
      last = e;
      await new Promise(r=>setTimeout(r, 250 + Math.random()*400));
    }
  }
  throw last;
}

/* =============== FINANCIAL FILTERS =============== */
const FINANCE_INCLUDE = [
  // macro & econ
  "cpi","inflation","pce","gdp","unemployment","payrolls","nfp","pmi","ism","retail sales","core","yoy","mom",
  // rates / fixed income
  "fed","fomc","rate","rates","hike","cut","treasury","bond","yield","bill","note","curve","term premium",
  // equities
  "s&p","spx","nasdaq","dow","equity","equities","stocks","earnings","recession",
  // credit / banks / housing
  "credit","cre","commercial real estate","bank","lending","mortgage","housing","builder",
  // commodities
  "oil","wti","brent","gasoline","gold","silver","copper",
  // fx / crypto
  "fx","eurusd","usdjpy","gbpusd","dxy","bitcoin","btc","ethereum","eth","crypto",
  // volatility
  "vix","volatility"
];
const FINANCE_EXCLUDE = [
  // politics & elections
  "election","president","primary","congress","senate","house","governor","parliament","minister","debate",
  // sports & entertainment
  "nfl","nba","mlb","nhl","soccer","fifa","olympic","oscar","grammy","emmy",
  // weather & misc
  "weather","hurricane","storm","earthquake","lottery"
];
function isFinancialTitle(t) {
  const s = (t||"").toLowerCase();
  if (FINANCE_EXCLUDE.some(bad => s.includes(bad))) return false;
  return FINANCE_INCLUDE.some(good => s.includes(good));
}

/* =============== Parsing (forgiving) =============== */
function looksTitle(s) {
  return s && s.length > 12 && !/^\d+%$/.test(s) && !/^\$?\d+(\.\d+)?$/.test(s);
}
function grabPct(s) {
  const m = s.match(/(\d{1,3})\s?%/);
  if (!m) return null;
  return clamp(parseInt(m[1],10), 0, 100);
}
function grabDollar(s) {
  const m = s.match(/\$([0-1]?\d?\.\d{2})/); // $0.00 - $9.99
  if (!m) return null;
  return clamp(parseFloat(m[1]), 0, 0.99);
}

function parsePolymarket(text) {
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const out = [];
  for (let i=0; i<lines.length && out.length<64; i++) {
    const t = lines[i];
    if (!looksTitle(t) || !isFinancialTitle(t)) continue;
    const pct = grabPct(t) ?? grabPct(lines[i+1]||"");
    if (pct != null) out.push({ source:"Polymarket", title:t.slice(0,160), probability:pct });
  }
  return out;
}

function parseKalshi(text) {
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const out = [];
  for (let i=0; i<lines.length && out.length<64; i++) {
    const t = lines[i];
    if (!looksTitle(t) || !isFinancialTitle(t)) continue;
    const price = grabDollar(lines[i]) ?? grabDollar(lines[i+1]||"");
    const pct = price != null ? clamp(Math.round(price*100), 0, 100) : null;
    if (pct != null) out.push({ source:"Kalshi", title:t.slice(0,160), probability:pct });
  }
  return out;
}

function dedupe(arr){
  const seen = new Set();
  return arr.filter(x=>{
    const k = (x.source+":"+x.title).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* =============== Generation & Fallback =============== */
async function generateForDay(env, day) {
  const [polyTxt, kalshiTxt] = await Promise.allSettled([
    fetchText(POLY_URL),
    fetchText(KALSHI_URL)
  ]);

  let items = [];
  if (polyTxt.status === "fulfilled")   items.push(...parsePolymarket(polyTxt.value));
  if (kalshiTxt.status === "fulfilled") items.push(...parseKalshi(kalshiTxt.value));

  items = dedupe(items).slice(0, MAX_ITEMS);

  if (items.length === 0) items = fallbackFinancial(day);

  await env.FORECASTS.put(day, JSON.stringify(items), { expirationTtl: 60*60*24*14 });
  return items;
}

function fallbackFinancial(day){
  // simple PRNG seeded by date
  const seed = [...day].reduce((a,c)=>a + c.charCodeAt(0), 0) >>> 0;
  let t = seed;
  const rnd = () => (t = (t * 1664525 + 1013904223) >>> 0) / 2**32;
  const templ = [
    "US CPI YoY ≥ 3.5% on next print",
    "Fed changes rates at next meeting",
    "WTI crude settles above $90 this month",
    "S&P 500 drawdown > 3% this week",
    "EURUSD ends month > 1.11",
    "BTC closes week above prior high",
    "10Y UST yield > 5% this quarter",
    "Core PCE YoY ≥ 3.0% on next print"
  ];
  const out = [];
  for (let i=0;i<6;i++){
    const title = templ[i % templ.length];
    out.push({ source:"Deterministic", title, probability: Math.round(30 + rnd()*50) });
  }
  return out;
}
