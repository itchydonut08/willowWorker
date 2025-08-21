export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/forecasts") {
      const date = url.searchParams.get("date") || utcDate();
      if (url.searchParams.get("force") === "1") {
        await generateSnapshot(env, date);
      }
      let snap = await env.FORECASTS.get(date, "json");
      if (!snap) snap = await generateSnapshot(env, date).catch(() => []);
      return cors(json({ date, items: snap }));
    }
    return new Response("Willow Forecasts Worker", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    const date = utcDate();
    ctx.waitUntil(generateSnapshot(env, date).catch(console.error));
  },
};

const POLY_URL = "https://r.jina.ai/http://polymarket.com/markets";
const KALSHI_URL = "https://r.jina.ai/http://kalshi.com/markets";

function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function generateSnapshot(env, date) {
  const [poly, kalshi] = await Promise.allSettled([
    fetchText(POLY_URL),
    fetchText(KALSHI_URL),
  ]);
  let items = [];
  if (poly.status === "fulfilled") items.push(...parseFinancial(poly.value, "Polymarket"));
  if (kalshi.status === "fulfilled") items.push(...parseFinancial(kalshi.value, "Kalshi"));
  if (!items.length) items = fallback(date);
  await env.FORECASTS.put(date, JSON.stringify(items), { expirationTtl: 60*60*24*14 });
  return items;
}

async function fetchText(url) {
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(r.status);
  return await r.text();
}

function parseFinancial(txt, src) {
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const include = ["cpi","inflation","gdp","fed","rate","treasury","bond","yield","s&p","nasdaq","equities","oil","wti","brent","gold","silver","copper","fx","eurusd","usdjpy","dxy","bitcoin","btc","ethereum","eth","vix","volatility"];
  const exclude = ["election","president","primary","congress","nba","nfl","mlb","oscars","grammy","weather"];
  const out = [];
  for (let l of lines) {
    const lower = l.toLowerCase();
    if (exclude.some(k => lower.includes(k))) continue;
    if (!include.some(k => lower.includes(k))) continue;
    const pct = (l.match(/(\d{1,3})\s?%/)||[])[1];
    if (pct) out.push({ source: src, title: l.slice(0,120), probability: +pct });
  }
  return out.slice(0, 16);
}

function fallback(date) {
  const seed = [...date].reduce((a,c)=>a+c.charCodeAt(0),0);
  function mulberry32(a){return function(){let t=(a+=0x6D2B79F5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;}}
  const rand = mulberry32(seed);
  const items = ["Fed decision","CPI print","BTC close","Oil price","S&P 500 weekly move"];
  return items.map(t=>({source:"Deterministic",title:t,probability:Math.round(30+rand()*50)}));
}

function json(o){return new Response(JSON.stringify(o),{headers:{"content-type":"application/json"}});}
function cors(r){const h=new Headers(r.headers);h.set("Access-Control-Allow-Origin","*");return new Response(r.body,{status:r.status,headers:h});}
