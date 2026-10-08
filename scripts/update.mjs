// Unmai auto-updater. Runs every 15 minutes on GitHub Actions (see .github/workflows/update.yml).
// 1. Pulls Tamil cinema headlines from Google News RSS (free, no key).
// 2. Tags each one (news / rumour / box office / review / OTT) and links it to a tracked film.
// 3. Fetches posters and backdrops from TMDB (needs the TMDB_TOKEN secret).
// 4. Writes data/live.json. The workflow commits it only if something changed.
// We only keep headlines and links, never article text.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = "data/live.json";
const FILMS = JSON.parse(readFileSync("data/films.json", "utf8"));
const TOKEN = process.env.TMDB_TOKEN || "";
const NOW = Date.now();
const KEEP_DAYS = 10;
const MAX_ITEMS = 160;

const QUERIES = [
  "Kollywood",
  "Tamil cinema",
  "Tamil movie",
  "Tamil film box office",
  "Tamil movie release date",
  "Tamil OTT release",
  "Jailer 2 Rajinikanth",
  ...FILMS.filter(f => f.year && f.year >= 2026).slice(0, 12).map(f => `"${f.aliases[0]}" Tamil`),
];

// Political and off-topic noise. Some stars are also politicians, so we filter on these words.
const BLOCK = /\b(chief minister|\bCM\b|TVK|DMK|AIADMK|BJP|election|assembly|minister|cabinet|rally|poll(s)? |vote|party worker|arrest|police|court case|cricket|IPL|stock|sensex|weather)\b/i;
const CINEMA = /\b(film|movie|cinema|kollywood|trailer|teaser|song|single|box office|collection|release|OTT|Netflix|Prime Video|Hotstar|ZEE5|Sun NXT|Aha|shooting|director|actor|actress|star|cast|cameo|review|audio launch|first look|poster|censor|U\/A|sequel|remake|BO|crore)\b/i;
const TAMIL = /\b(tamil|kollywood|chennai|rajinikanth|rajini|kamal|vijay sethupathi|ajith|suriya|karthi|dhanush|sivakarthikeyan|simbu|silambarasan|vikram|nayanthara|trisha|keerthy|anirudh|lokesh|nelson|vetrimaaran|mani ratnam|shankar|atlee|sun pictures|lyca|soori|vishal|jayam ravi|ravi mohan|arya|udhayanidhi)\b/i;

const RUMOUR = /\b(reportedly|rumou?r|buzz|likely|speculat|said to be|in talks|could|may (star|join|play|release)|report(s)? suggest|sources say|insiders?|whispers?)\b/i;
const BOX = /\b(box office|collection|crore|day \d+|weekend|opening day|gross|net)\b/i;
const REVIEW = /\b(review|rating|verdict)\b/i;
const OTTW = /\b(OTT|Netflix|Prime Video|JioHotstar|Hotstar|ZEE5|Sun NXT|SonyLIV|Aha|streaming)\b/i;

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/<[^>]+>/g, "").trim();

const pick = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]) : ""; };

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    let title = pick(x, "title");
    const source = pick(x, "source");
    const srcUrl = (x.match(/<source url="([^"]+)"/) || [])[1] || "";
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(" - " + source).length);
    const link = pick(x, "link");
    const ts = Date.parse(pick(x, "pubDate"));
    if (title && link && ts) items.push({ title, source: source || "Web", srcUrl, url: link, ts });
  }
  return items;
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const words = s => new Set(norm(s).split(" ").filter(w => w.length > 2));
function similar(a, b) { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)); }

export function matchFilm(title) {
  for (const f of FILMS) {
    for (const a of f.aliases) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i");
      if (re.test(title) && (!f.needs || !f.needs.length || f.needs.some(n => title.toLowerCase().includes(n.toLowerCase())))) return f.id;
    }
  }
  return null;
}

export function tagOf(title) {
  if (REVIEW.test(title)) return "review";
  if (BOX.test(title) && /crore|box office|collection/i.test(title)) return "box";
  if (OTTW.test(title)) return "ott";
  if (RUMOUR.test(title)) return "rumour";
  return "news";
}

export function relevant(it) {
  const t = it.title;
  if (BLOCK.test(t)) return false;
  if (!CINEMA.test(t) && !matchFilm(t)) return false;
  if (!TAMIL.test(t) && !matchFilm(t) && !/tamil|kollywood/i.test(it.query || "")) return false;
  return true;
}

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": "UnmaiBot/1.0 (+https://unmai.snyp.io)", ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

async function fetchNews() {
  const all = [];
  for (const q of QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:3d")}&hl=en-IN&gl=IN&ceid=IN:en`;
    try {
      const xml = await (await get(url)).text();
      for (const it of parseRss(xml)) all.push({ ...it, query: q });
    } catch (e) { console.warn("news fetch failed:", q, e.message); }
  }
  return all;
}

async function tmdb(path) {
  const r = await get(`https://api.themoviedb.org/3${path}`, { Authorization: `Bearer ${TOKEN}`, accept: "application/json" });
  return r.json();
}

async function fetchPosters(prev) {
  const posters = { ...(prev.posters || {}) };
  if (!TOKEN) { console.warn("No TMDB_TOKEN, skipping posters"); return posters; }
  const tried = prev.postersTried || {};
  let calls = 0;
  for (const f of FILMS) {
    if (!f.search || posters[f.id]?.poster) continue;
    if (tried[f.id] && NOW - tried[f.id] < 6 * 3600e3) continue; // retry misses every 6 hours
    if (calls++ >= 15) break;
    tried[f.id] = NOW;
    try {
      const q = `/search/movie?query=${encodeURIComponent(f.title)}${f.year ? `&primary_release_year=${f.year}` : ""}&language=en-US`;
      let res = (await tmdb(q)).results || [];
      if (!res.length && f.year) res = (await tmdb(`/search/movie?query=${encodeURIComponent(f.title)}&language=en-US`)).results || [];
      const best = res.find(r => r.original_language === "ta" && (r.poster_path || r.backdrop_path)) || null;
      if (best) posters[f.id] = {
        tmdb: best.id,
        poster: best.poster_path ? `https://image.tmdb.org/t/p/w342${best.poster_path}` : null,
        backdrop: best.backdrop_path ? `https://image.tmdb.org/t/p/w780${best.backdrop_path}` : null,
      };
    } catch (e) { console.warn("tmdb failed:", f.id, e.message); }
  }
  prev.postersTried = tried;
  return posters;
}

async function main() {
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { items: [] };
  const raw = await fetchNews();
  const fresh = raw.filter(it => NOW - it.ts < KEEP_DAYS * 864e5 && it.ts <= NOW + 36e5 && relevant(it));

  // Merge with what we already had, newest first, dropping near-duplicate headlines.
  const pool = [...fresh, ...(prev.items || [])].sort((a, b) => b.ts - a.ts);
  const kept = [];
  for (const it of pool) {
    if (NOW - it.ts > KEEP_DAYS * 864e5) continue;
    if (kept.some(k => k.url === it.url || similar(k.title, it.title) > 0.7)) continue;
    const film = it.film !== undefined ? it.film : matchFilm(it.title);
    kept.push({
      id: it.id || Buffer.from(norm(it.title)).toString("base64url").slice(0, 16),
      title: it.title, source: it.source, srcUrl: it.srcUrl || "", url: it.url, ts: it.ts,
      tag: it.tag || tagOf(it.title), film,
    });
    if (kept.length >= MAX_ITEMS) break;
  }

  const posters = await fetchPosters(prev);
  const sameItems = JSON.stringify((prev.items || []).map(i => i.id)) === JSON.stringify(kept.map(i => i.id));
  const samePosters = JSON.stringify(prev.posters || {}) === JSON.stringify(posters);
  if (sameItems && samePosters) { console.log("No changes."); return; }

  const out = { updated: NOW, items: kept, posters, postersTried: prev.postersTried || {} };
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${kept.length} items (${fresh.length} fetched this run), ${Object.keys(posters).length} films with images.`);
}

if (process.argv[1] && process.argv[1].endsWith("update.mjs")) main().catch(e => { console.error(e); process.exit(1); });
