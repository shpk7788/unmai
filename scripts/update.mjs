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
const TAMIL = /\b(tamil|kollywood|chennai|rajinikanth|rajini|kamal|vijay sethupathi|ajith|suriya|karthi|dhanush|sivakarthikeyan|simbu|silambarasan|vikram|nayanthara|trisha|keerthy|anirudh|lokesh|nelson|vetrimaaran|mani ratnam|shankar|atlee|sun pictures|lyca|soori|vishal|jayam ravi|ravi mohan|arya|udhayanidhi|subbaraj|mari selvaraj|ashok selvan|mamitha|jason sanjay|sananth|arulnithi|atharvaa|vijay antony|prabhu ?deva|g\.? ?v\.? prakash|pa\.? ranjith|venkat prabhu|ilaiyaraaja|a\.? ?r\.? rahman|yuvan|santhosh narayanan|vadivelu|yogi babu|gautham (vasudev )?menon|selvaraghavan|sathyaraj|arvind swamy|kavin|harish kalyan|sundar c|hiphop tamizha|lyca|red giant|wunderbar|raaj kamal|sathya jyothi|ashwath|vetri maaran|indian 3|thalaivar|thalapathy|ulaganayagan)\b/i;

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

const OTHER = /\b(malayalam|telugu|kannada|hindi|bollywood|tollywood|mollywood|sandalwood|bengali|marathi|punjabi|hollywood|korean|anime|doraemon)\b/i;

export function relevant(it) {
  const t = it.title, film = it.film || matchFilm(t);
  if (BLOCK.test(t)) return false;
  if (film) return true;
  if (!TAMIL.test(t)) return false;
  if (OTHER.test(t) && !/tamil|kollywood/i.test(t)) return false;
  return CINEMA.test(t);
}

// Items from a film-specific search belong to that film when the title names it.
function filmFromQuery(q, title) {
  for (const f of FILMS) if (q.includes(`"${f.aliases[0]}"`) && title.toLowerCase().includes(f.aliases[0].toLowerCase())) return f.id;
  return null;
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
      for (const it of parseRss(xml)) all.push({ ...it, query: q, film: matchFilm(it.title) || filmFromQuery(q, it.title) });
    } catch (e) { console.warn("news fetch failed:", q, e.message); }
  }
  return all;
}

/* ---------- summaries ----------
   For each new headline: find the real article URL behind the Google News link, read the article,
   and ask a small AI model for a short
   summary in our own words (free Gemini API). Only the summary and the link are stored, never the article text. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SUM_PER_RUN = 4;

export async function decodeGoogleNews(url) {
  const m = url.match(/news\.google\.com\/(?:rss\/)?articles\/([^?]+)/);
  if (!m) return url;
  const id = m[1];
  const page = await (await fetch(`https://news.google.com/articles/${id}`, { headers: { "User-Agent": UA } })).text();
  const sg = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1], ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) return null;
  const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, +ts, sg]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]));
  const r = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": UA }, body });
  const txt = await r.text();
  const hit = txt.match(/garturlres\\",\\"(.*?)\\"/);
  return hit ? JSON.parse(`"${hit[1].replace(/\\\\/g, "\\")}"`) : null;
}

export function articleText(html) {
  const og = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i) || [])[1] || "";
  const body = html.replace(/<(script|style|noscript|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => decode(x[1])).filter(t => t.length > 60);
  return decode(og) + "\n" + paras.join("\n").slice(0, 6000);
}

const SYSTEM = `You write short news summaries for Unmai, a Tamil cinema news website.
Write 2 to 4 plain sentences, at most 70 words, in your own words, using only facts in the article text.
Never copy sentences from the article. Never add facts that are not in the text.
If something is unconfirmed (sources, reportedly, buzz, likely), say it is reported, not confirmed.
No hype, no emoji, and don't repeat the headline word for word.
If the text is empty, is not about the headline, or is not about Tamil cinema, reply with exactly: SKIP`;

let modelBlocked = false;
const DIAG = { attempts: 0, ok: 0, noUrl: 0, fetchErr: 0, short: 0, skip: 0, ai: [] };
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
let geminiModel = 0;

// Free Gemini API (Google AI Studio key saved as the GEMINI_API_KEY secret).
async function summarise(title, source, text) {
  if (!GEMINI_KEY) { DIAG.ai.push("no GEMINI_API_KEY secret yet"); modelBlocked = true; return null; }
  if (modelBlocked) return null;
  while (geminiModel < GEMINI_MODELS.length) {
    const model = GEMINI_MODELS[geminiModel];
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `Headline: ${title}\nPublisher: ${source}\n\nArticle text:\n${text}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 400, ...(model.startsWith("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
    };
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body),
      });
      if (r.status === 429) { modelBlocked = true; DIAG.ai.push(`429 ${model}`); return null; }
      if (!r.ok) { DIAG.ai.push(`${r.status} ${model}: ${(await r.text()).slice(0, 140)}`); geminiModel++; continue; }
      const j = await r.json();
      const out = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
      if (!out || /^SKIP/i.test(out)) return "SKIP";
      return out.replace(/\s+/g, " ").slice(0, 600);
    } catch (e) { DIAG.ai.push(`err ${model}: ${e.message}`); geminiModel++; }
  }
  modelBlocked = true;
  return null;
}

async function addSummaries(items, tried) {
  let done = 0;
  for (const it of items) {
    if (done >= SUM_PER_RUN || modelBlocked || DIAG.attempts >= 10) break;
    if (it.sum || (tried[it.id] && NOW - tried[it.id] < 12 * 3600e3)) continue;
    DIAG.attempts++;
    try {
      const real = it.realUrl || (await decodeGoogleNews(it.url));
      if (!real) { DIAG.noUrl++; tried[it.id] = NOW; continue; }
      it.realUrl = real;
      const res = await fetch(real, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en" }, redirect: "follow" });
      if (!res.ok) { DIAG.fetchErr++; tried[it.id] = NOW; continue; }
      const text = articleText(await res.text());
      if (text.length < 200) { DIAG.short++; tried[it.id] = NOW; continue; }
      const sum = await summarise(it.title, it.source, text);
      if (sum === "SKIP") { DIAG.skip++; tried[it.id] = NOW; }
      else if (sum) { it.sum = sum; done++; DIAG.ok++; }
      // sum === null means the AI call failed: don't mark as tried, retry next run
    } catch (e) { DIAG.fetchErr++; tried[it.id] = NOW; console.warn("summary failed:", it.title.slice(0, 50), e.message); }
  }
  console.log(`Added ${done} summaries.`, JSON.stringify(DIAG));
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
    if (NOW - it.ts > KEEP_DAYS * 864e5 || !relevant(it)) continue;
    if (kept.some(k => k.url === it.url || similar(k.title, it.title) > 0.7)) continue;
    const film = it.film || matchFilm(it.title);
    kept.push({
      id: it.id || Buffer.from(norm(it.title)).toString("base64url").slice(0, 16),
      title: it.title, source: it.source, srcUrl: it.srcUrl || "", url: it.url, ts: it.ts,
      tag: it.tag || tagOf(it.title), film,
      ...(it.realUrl ? { realUrl: it.realUrl } : {}), ...(it.sum ? { sum: it.sum } : {}),
    });
    if (kept.length >= MAX_ITEMS) break;
  }

  const posters = await fetchPosters(prev);
  const sumTried = prev.sumTried2 || {};
  await addSummaries(kept, sumTried);
  for (const k of Object.keys(sumTried)) if (NOW - sumTried[k] > 3 * 864e5) delete sumTried[k];
  const sig = list => JSON.stringify((list || []).map(i => [i.id, i.sum || ""]));
  const sameItems = sig(prev.items) === sig(kept);
  const samePosters = JSON.stringify(prev.posters || {}) === JSON.stringify(posters);
  const sameDiag = JSON.stringify(prev.diag || {}) === JSON.stringify(DIAG);
  if (sameItems && samePosters && sameDiag) { console.log("No changes."); return; }

  const out = { updated: NOW, items: kept, posters, postersTried: prev.postersTried || {}, sumTried2: sumTried, diag: DIAG };
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${kept.length} items (${fresh.length} fetched this run), ${Object.keys(posters).length} films with images.`);
}

if (process.argv[1] && process.argv[1].endsWith("update.mjs")) main().catch(e => { console.error(e); process.exit(1); });
