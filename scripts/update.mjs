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
  "Kollywood celebrity",
  "Tamil actress",
  "Tamil actor wedding",
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

// Low-value formats we never show: song uploads, weekly OTT listicles, generic lists.
const JUNK = /(ott releases this week|\|\s*(song|lyric|video)|\b(lyric(al)? video|video song|full song|jukebox|horoscope)\b|\bott releases? (this|of the) week\b|\bnew ott releases\b|\b(top|best) \d+ |\bwatch online free\b|\bdownload\b)/i;
const OTHER = /\b(malayalam|telugu|kannada|hindi|bollywood|tollywood|mollywood|sandalwood|bengali|marathi|punjabi|hollywood|korean|anime|doraemon)\b/i;

export function relevant(it) {
  const t = it.title, film = it.film || matchFilm(t);
  if (BLOCK.test(t) || JUNK.test(t)) return false;
  if (film) return true;
  if (!TAMIL.test(t)) return false;
  if (OTHER.test(t) && !/tamil|kollywood/i.test(t)) return false;
  return CINEMA.test(t) || CELEB.test(t);
}
// Public-life celebrity news (the AI later drops private-life speculation).
const CELEB = /\b(actor|actress|star|celebrity|wedding|married|engaged|engagement|birthday|instagram|post(ed|s)?|photos?|pics|look|outfit|vacation|fans|viral|reacts?|slams|responds|interview|award|honou?red|temple|visit(s|ed)?)\b/i;

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
const SUM_PER_RUN = 12;

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

// The photo the publisher ran with this story (usually the official still or press photo for this exact news).
export function articlePhoto(html) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]+content=["']([^"']+)/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  const u = m ? decode(m[1]).trim() : "";
  if (!/^https:\/\//.test(u) || /logo|default|placeholder|fallback|favicon|sprite|blank|no-?image/i.test(u)) return "";
  return u;
}

// Videos and posts embedded in the article: the trailer or song on YouTube, and the official
// announcement post (from the star, director or studio) on X/Twitter.
export function articleEmbeds(html) {
  const yt = [...new Set([...html.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)].map(m => m[1]))].slice(0, 4);
  const tw = [...new Set([...html.matchAll(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{8,20})/g)]
    .filter(m => !/^(share|intent|i|home|search)$/i.test(m[1])).map(m => `https://twitter.com/${m[1]}/status/${m[2]}`))].slice(0, 4);
  return { yt, tw };
}
const stripTags = h => decode(String(h).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const keyWords = t => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3));
// A video counts only if it is about this story: not the publisher's own promo, and sharing at least
// two meaningful words (film, star, song name) with the story.
const GENERIC = new Set("tamil official video trailer teaser song lyric lyrical full movie film cinema news latest with from this that their what when star starrer".split(" "));
export function videoFits(it, v) {
  const pub = String(it.source || "").toLowerCase();
  if (pub && (String(v.ch).toLowerCase().includes(pub.split(" ").slice(-2).join(" ")) || String(v.title).toLowerCase().includes(pub))) return false;
  const ctx = keyWords(`${String(it.title).replace(/\s+-\s+[^-]+$/, "")} ${it.hook || ""} ${(FILMS.find(f => f.id === it.film) || {}).title || ""}`);
  return [...keyWords(v.title)].filter(w => ctx.has(w) && !GENERIC.has(w)).length >= 2;
}
async function enrichMedia(it, page) {
  const { yt, tw } = articleEmbeds(page);
  const vids = [];
  for (const id of yt) {
    if (vids.length >= 1) break;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}&format=json`);
      if (!r.ok) continue;
      const j = await r.json();
      const v = { id, title: stripTags(j.title).slice(0, 140), ch: String(j.author_name || "").slice(0, 60) };
      if (videoFits(it, v)) vids.push(v);
    } catch {}
  }
  const posts = [];
  for (const url of tw) {
    if (posts.length >= 2) break;
    try {
      const r = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=true`);
      if (!r.ok) continue;
      const j = await r.json();
      const body = (String(j.html).match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "";
      const text = stripTags(body.replace(/<a[^>]*>(pic\.twitter\.com|https?:\/\/t\.co)[^<]*<\/a>/gi, "")).slice(0, 400);
      const date = stripTags((String(j.html).match(/<a[^>]*>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>\s*<\/blockquote>/) || [])[1] || "");
      const handle = (url.match(/twitter\.com\/([^/]+)/) || [])[1];
      if (text) posts.push({ url, by: String(j.author_name || handle).slice(0, 60), handle, text, date });
    } catch {}
  }
  it.videos = vids; it.posts = posts;
}

export function articleText(html) {
  const og = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i) || [])[1] || "";
  const body = html.replace(/<(script|style|noscript|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => decode(x[1])).filter(t => t.length > 60);
  return decode(og) + "\n" + paras.join("\n").slice(0, 6000);
}

const SYSTEM = `You write posts for Unmai, a Tamil cinema news app read by fans on their phones.
From the article text, return JSON with these fields:
"points": 2 to 3 short bullet points that carry the juice, each under 16 words, each a complete fact (names, numbers, dates). The first point is the headline fact; don't repeat the hook word for word. No filler.
"quote": the single most telling direct quote from a named person in the article, under 22 words, as {"text": "...", "by": "Name, role"}; or null if nobody is quoted.
"hook": a short, punchy headline in your own words (max 12 words) that makes a fan want to read on. It must be accurate: no exaggeration, no question bait, no claims that aren't in the text, no ALL CAPS, no emoji.
"summary": the whole story told on its own so the reader never needs the original article: 3 to 5 short sentences, 60 to 90 words. Lead with the single most interesting fact. Then the juice: names, numbers, dates, what was actually said. If someone is quoted, include their most telling line as a short direct quote (under 20 words) with who said it. Skip filler, background everyone knows, and promotional fluff. Never end with a sentence about fans being excited, the film being much awaited, or what fans can expect: stop when the facts run out. Write like a sharp entertainment reporter, in plain English and in your own words; apart from that one quote, never copy sentences from the article. If something is unconfirmed (sources, reportedly, buzz), say it is reported, not confirmed.
"cat": one of "box" (box office), "release" (release dates, trailers, teasers, songs, first looks, censor), "casting" (new films, who is in or directing what, shoots), "ott" (streaming), "rumour" (unconfirmed reports), "celeb" (stars' public lives: appearances, social posts, weddings or engagements they announced, birthdays, awards, fashion, statements), "other".
"score": a whole number 1 to 10 for how interesting this is to Tamil cinema fans. 8 to 10: big-star films, release dates, trailers, box office milestones, casting news, confirmed or busted rumours. 4 to 7: smaller films, interviews with news in them, OTT dates. Celebrity news the star made public or did in public (a post, an appearance, an announced wedding, an award, a reply to critics in their own words) scores 5 to 8 when it involves a well-known Tamil star. 1 to 3: song uploads, listicles, anything not about Tamil cinema, and any speculation about a person's dating life, health, pregnancy, divorce or family that they have not confirmed themselves (score these 1 and keep the summary neutral).
Use only facts in the article text. If the text is empty or unrelated to the headline, return {"hook":"","summary":"","score":0}.`;

let modelBlocked = false;
const BLOCKED = new Set(); // models that hit their free-tier limit this run
const DIAG = { attempts: 0, ok: 0, noUrl: 0, fetchErr: 0, short: 0, skip: 0, ai: [], models: [] };
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
let GEMINI_MODELS = null;

// Ask Google which Flash models this key can use, so retired model names never break us.
async function geminiModels() {
  if (GEMINI_MODELS) return GEMINI_MODELS;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": GEMINI_KEY } });
    const j = await r.json();
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
    const rank = n => /flash-lite-latest$/.test(n) ? 0 : /flash-latest$/.test(n) ? 1 : /flash-lite/.test(n) ? 2 : /flash/.test(n) ? 3 : 9;
    GEMINI_MODELS = names.filter(n => rank(n) < 9 && !/image|tts|audio|live|embedding|preview|omni/.test(n)).sort((x, y) => rank(x) - rank(y) || y.localeCompare(x)).slice(0, 5);
    DIAG.models = GEMINI_MODELS;
  } catch (e) { DIAG.ai.push("model list failed: " + e.message); }
  if (!GEMINI_MODELS || !GEMINI_MODELS.length) GEMINI_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
  return GEMINI_MODELS;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Free Gemini API (Google AI Studio key saved as the GEMINI_API_KEY secret).
async function summarise(title, source, text) {
  if (!GEMINI_KEY) { DIAG.ai.push("no GEMINI_API_KEY secret yet"); modelBlocked = true; return null; }
  if (modelBlocked) return null;
  const models = (await geminiModels()).filter(m => !BLOCKED.has(m)).slice(0, 5);
  if (!models.length) { modelBlocked = true; return null; }
  for (const model of models) {
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `Headline: ${title}\nPublisher: ${source}\n\nArticle text:\n${text}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: "application/json" },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body),
        });
        if (r.status === 429) { BLOCKED.add(model); DIAG.ai.push(`429 ${model}`); break; } // this model's quota is used up: try the next one
        if (r.status === 503 || r.status === 500) { DIAG.ai.push(`${r.status} ${model}`); await sleep(1500); break; } // busy: try the next model
        if (!r.ok) { DIAG.ai.push(`${r.status} ${model}: ${(await r.text()).slice(0, 120)}`); break; }
        const j = await r.json();
        const out = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
        let o; try { o = JSON.parse(out.replace(/^```(json)?|```$/g, "")); } catch { DIAG.ai.push(`bad json ${model}`); return "SKIP"; }
        if (!o || !o.summary || !(+o.score > 0)) return "SKIP";
        const tidyQ = q => q && q.text && q.by ? { text: String(q.text).replace(/^["“”']+|["“”']+$/g, "").replace(/\s+/g, " ").trim().slice(0, 200), by: String(q.by).trim().slice(0, 60) } : null;
        const tidy = x => String(x || "").replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1").replace(/\s+/g, " ").trim();
        return { hook: tidy(o.hook).slice(0, 120), sum: (s => s.length <= 900 ? s : s.slice(0, 900).replace(/[^.!?]*$/, ""))(tidy(o.summary)), points: (Array.isArray(o.points) ? o.points : []).map(x => String(x).replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3), quote: tidyQ(o.quote),
          score: Math.max(1, Math.min(10, Math.round(+o.score))), ...(o.cat ? { cat: String(o.cat).toLowerCase().slice(0, 10) } : {}) };
      } catch (e) { DIAG.ai.push(`err ${model}: ${e.message}`); break; }
    }
  }
  return null; // every model failed for this story: leave it for the next run
}

async function addSummaries(items, tried) {
  let done = 0;
  for (const it of items) {
    if (done >= SUM_PER_RUN || modelBlocked || DIAG.attempts >= 16) break;
    if (it.v === 3 || (tried[it.id] && NOW - tried[it.id] < 12 * 3600e3)) continue;
    DIAG.attempts++;
    try {
      const real = it.realUrl || (await decodeGoogleNews(it.url));
      if (!real) { DIAG.noUrl++; tried[it.id] = NOW; continue; }
      it.realUrl = real;
      const res = await fetch(real, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en" }, redirect: "follow" });
      if (!res.ok) { DIAG.fetchErr++; tried[it.id] = NOW; continue; }
      const page = await res.text();
      it.photo = articlePhoto(page);
      await enrichMedia(it, page);
      const text = articleText(page);
      if (text.length < 200) { DIAG.short++; tried[it.id] = NOW; continue; }
      const res2 = await summarise(it.title, it.source, text);
      if (res2 === "SKIP") { DIAG.skip++; it.score = 0; tried[it.id] = NOW; }
      else if (res2) { Object.assign(it, res2, { v: 3 }); done++; DIAG.ok++; }
      // sum === null means the AI call failed: don't mark as tried, retry next run
    } catch (e) { DIAG.fetchErr++; tried[it.id] = NOW; console.warn("summary failed:", it.title.slice(0, 50), e.message); }
  }
  for (const it of items) if (it.videos) it.videos = it.videos.filter(v => videoFits(it, v));
  let ph = 0;
  for (const it of items) {
    if (ph >= 30 || (it.photo !== undefined && it.videos) || !it.v || !it.realUrl) continue; // stories written before photos/videos existed
    ph++;
    try { const r = await fetch(it.realUrl, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en" }, redirect: "follow" });
      const page = r.ok ? await r.text() : ""; it.photo = articlePhoto(page); await enrichMedia(it, page); }
    catch { it.photo = ""; it.videos = []; it.posts = []; }
  }
  DIAG.photos = ph;
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
  // A gallery of stills per film, so posts about the same film don't all show the same picture.
  let gcalls = 0;
  for (const [id, P] of Object.entries(posters)) {
    if (!P.tmdb || P.gallery || gcalls >= 12) continue;
    gcalls++;
    try {
      const j = await tmdb(`/movie/${P.tmdb}/images?include_image_language=null,en,ta`);
      const pick = (list, size, n) => (list || []).filter(x => x.file_path).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)).slice(0, n).map(x => `https://image.tmdb.org/t/p/${size}${x.file_path}`);
      const g = [...new Set([P.backdrop, ...pick(j.backdrops, "w780", 12)].filter(Boolean))];
      P.gallery = g;
      P.posters = pick(j.posters, "w342", 6);
    } catch (e) { console.warn("tmdb images failed:", id, e.message); }
  }
  prev.postersTried = tried;
  return posters;
}

async function main() {
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { items: [] };
  const raw = await fetchNews();
  const fresh = raw.filter(it => NOW - it.ts < KEEP_DAYS * 864e5 && it.ts <= NOW + 36e5 && relevant(it));

  // Merge with what we already had. Work we've already done (summary, hook, score, real link,
  // other outlets) is carried over by id or url, so it survives every run.
  const idOf = it => it.id || Buffer.from(norm(it.title)).toString("base64url").slice(0, 16);
  const prevById = new Map(), prevByUrl = new Map();
  for (const p of prev.items || []) { prevById.set(p.id, p); prevByUrl.set(p.url, p); }
  const pool = [...(prev.items || []), ...fresh].sort((a, b) => b.ts - a.ts);
  const kept = [];
  for (const raw of pool) {
    if (NOW - raw.ts > KEEP_DAYS * 864e5 || !relevant(raw)) continue;
    const id = idOf(raw), old = prevById.get(id) || prevByUrl.get(raw.url) || {};
    const it = { ...old, ...raw, id: old.id || id };
    // Same story from another outlet: fold it into the existing post instead of repeating it.
    const twin = kept.find(k => k.url === it.url || similar(k.title, it.title) > 0.6);
    if (twin) {
      if (twin.url !== it.url && twin.source !== it.source && !(twin.also || []).some(a => a.source === it.source)) (twin.also = twin.also || []).push({ source: it.source, url: it.url });
      continue;
    }
    kept.push({
      id: it.id, title: it.title, source: it.source, srcUrl: it.srcUrl || "", url: it.url, ts: it.ts,
      tag: it.tag || tagOf(it.title), film: it.film || matchFilm(it.title),
      ...(it.realUrl ? { realUrl: it.realUrl } : {}), ...(it.sum ? { sum: it.sum } : {}),
      ...(it.hook ? { hook: it.hook } : {}), ...(it.v ? { v: it.v } : {}), ...(it.cat ? { cat: it.cat } : {}), ...(it.points && it.points.length ? { points: it.points } : {}), ...(it.quote ? { quote: it.quote } : {}), ...(it.photo !== undefined ? { photo: it.photo } : {}), ...(it.videos ? { videos: it.videos } : {}), ...(it.posts ? { posts: it.posts } : {}), ...(it.score !== undefined ? { score: it.score } : {}),
      ...(it.also && it.also.length ? { also: it.also.slice(0, 8) } : {}),
    });
    if (kept.length >= MAX_ITEMS) break;
  }

  const posters = await fetchPosters(prev);
  const sumTried = prev.sumTried3 || {};
  await addSummaries(kept, sumTried);
  for (const k of Object.keys(sumTried)) if (NOW - sumTried[k] > 3 * 864e5) delete sumTried[k];
  const sig = list => JSON.stringify((list || []).map(i => [i.id, i.sum || "", i.hook || "", (i.also || []).length, i.photo || "", i.cat || "", (i.videos || []).length, (i.posts || []).length]));
  const sameItems = sig(prev.items) === sig(kept);
  const samePosters = JSON.stringify(prev.posters || {}) === JSON.stringify(posters);
  const sameDiag = JSON.stringify(prev.diag || {}) === JSON.stringify(DIAG);
  if (sameItems && samePosters && sameDiag) { console.log("No changes."); return; }

  const out = { updated: NOW, items: kept, posters, postersTried: prev.postersTried || {}, sumTried3: sumTried, diag: DIAG };
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${kept.length} items (${fresh.length} fetched this run), ${Object.keys(posters).length} films with images.`);
}

if (process.argv[1] && process.argv[1].endsWith("update.mjs")) main().catch(e => { console.error(e); process.exit(1); });
