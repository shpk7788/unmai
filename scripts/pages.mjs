// Builds plain, crawlable HTML pages for search engines from the same data the app uses:
//   /film/<id>.html              one page per tracked film (details, release date, reviews, latest news in our own words)
//   /tamil-movie-release-dates.html   upcoming and recent releases
//   /sitemap.xml, /robots.txt
// Run after update.mjs. Pure Node, no dependencies.
import fs from "node:fs";
import vm from "node:vm";

// The domain comes from the CNAME file, so changing domains means editing CNAME only.
const SITE = "https://" + (fs.existsSync("CNAME") ? fs.readFileSync("CNAME", "utf8").trim() : "unmai.snyp.io");
// Point canonical links and share tags in the hand-written pages at the current domain:
// whatever host index.html's canonical link names is swapped for the one in CNAME.
{
  const oldHost = (fs.readFileSync("index.html", "utf8").match(/rel="canonical" href="https:\/\/([^/"]+)/) || [])[1];
  const newHost = SITE.slice(8);
  if (oldHost && oldHost !== newHost) for (const f of ["index.html", "about.html", "privacy.html"])
    if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("https://" + oldHost).join("https://" + newHost));
}
const html = fs.readFileSync("index.html", "utf8");
const live = JSON.parse(fs.readFileSync("data/live.json", "utf8"));

// Pull the film table (const F={...};) and rumours (const RUMS=[...];) out of the app so there is one source of truth.
function grab(name, open, close) {
  const start = html.indexOf(`const ${name}=${open}`);
  if (start < 0) return null;
  let i = html.indexOf(open, start), depth = 0, q = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) break;
  }
  return vm.runInNewContext("(" + html.slice(html.indexOf(open, start), i + 1) + ")");
}
const F = grab("F", "{", "}") || {};
const RUMS = grab("RUMS", "[", "]") || [];
const posters = live.posters || {};
const items = live.items || [];

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = d => { const x = new Date(d); return isNaN(x) ? "" : `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
const today = new Date().toISOString().slice(0, 10);

const CSS = `:root{--ink:#0F1419;--soft:#3B4249;--muted:#6E767D;--line:#E7E9EB;--pop:#F26B1D;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--ink:#E9ECEF;--soft:#B7BEC6;--muted:#8A939C;--line:#262C33}body{background:#0E1116}}
body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:#fff}
main{max-width:680px;margin:0 auto;padding:0 18px 48px}
header{display:flex;align-items:center;gap:10px;padding:14px 18px;max-width:680px;margin:0 auto;border-bottom:1px solid var(--line)}
header a{display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit;font-weight:800;font-size:19px}
header img{width:30px;height:30px;border-radius:8px}
.open{margin-left:auto;background:var(--pop);color:#fff;padding:8px 14px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none}
h1{font-size:28px;line-height:1.2;margin:22px 0 8px;letter-spacing:-.015em}h2{font-size:20px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 16px}.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:16px 0}
.facts dt{color:var(--muted)}.facts dd{margin:0;font-weight:600}
.hero{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:14px;background:#2228}
article{padding:14px 0;border-bottom:1px solid var(--line)}article h3{margin:0 0 4px;font-size:17px;line-height:1.35}
article p{margin:0 0 6px;color:var(--soft)}.src{font-size:13.5px;color:var(--muted)}.src a{color:inherit}
table{width:100%;border-collapse:collapse}td,th{padding:10px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:13px;color:var(--muted)}
td a{color:inherit;font-weight:700}.tag{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--pop)}
footer{max-width:680px;margin:0 auto;padding:18px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line)}footer a{color:inherit}`;

function page({ path, title, desc, body, image, jsonld, noindex }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${path}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${esc(image || SITE + "/icons/icon-512.png")}"><meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}<style>${CSS}</style></head><body>
<header><a href="/"><img src="/icons/favicon.svg" alt="">Unmai</a><a class="open" href="/">Open the live feed</a></header>
<main>${body}</main>
<footer><a href="/tamil-movie-release-dates.html">Tamil release dates</a> · <a href="/about.html">About</a> · <a href="/privacy.html">Privacy</a><br>
Film images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. News summaries are written by Unmai and link to the original reports.</footer>
</body></html>`;
}

const urls = [{ loc: "/", pri: "1.0" }, { loc: "/tamil-movie-release-dates.html", pri: "0.9" }, { loc: "/about.html", pri: "0.3" }, { loc: "/privacy.html", pri: "0.2" }];
fs.mkdirSync("film", { recursive: true });

// ---- one page per film
const filmIds = Object.keys(F);
for (const id of filmIds) {
  const f = F[id], P = posters[id] || {};
  const news = items.filter(w => w.film === id);
  const written = news.filter(w => w.sum && !(w.score < 4));
  const rums = RUMS.filter(r => r.f === id);
  const thin = !written.length && !f.rev && !f.cal && !rums.length && !f.note;
  const yr = (f.d || "").slice(0, 4) || "2026";
  const title = `${f.t} (${yr}): Release Date, Cast, Reviews and Latest News | Unmai`;
  const desc = [f.gen && `${f.t} is a Tamil ${f.gen.toLowerCase()}`, f.dir && `directed by ${f.dir}`, f.cast && `starring ${f.cast}`].filter(Boolean).join(", ") + ". Release date, reviews, box office and the latest verified news.";
  const facts = [["Director", f.dir], ["Cast", f.cast], ["Genre", f.gen], ["Release", f.d ? fmt(f.d) + (f.conf ? " (confirmed)" : " (expected)") : f.where], ["Box office", f.box && `${f.box.v} India net, ${f.box.note} (${f.box.src})`]].filter(x => x[1]);
  let body = `<h1>${esc(f.t)}</h1><p class="sub">Tamil film · ${esc(yr)}</p>`;
  if (P.backdrop || P.poster) body += `<img class="hero" src="${esc(P.backdrop || P.poster)}" alt="${esc(f.t)} still" loading="eager">`;
  body += `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  if (f.note) body += `<p>${esc(f.note)}</p>`;
  if (f.rev) {
    const pos = f.rev.filter(r => r[3] === 1).length;
    body += `<h2>What critics said</h2><p>${pos} of ${f.rev.length} critics reviewed it positively.</p>` +
      f.rev.map(([o, cr, rt, vd, t, u]) => `<article><h3>${esc(o)}${rt ? ` · ${esc(rt)}` : ""}</h3><p>${esc(t)}</p><div class="src">${esc(cr || "")} ${u ? `· <a href="${esc(u)}" rel="nofollow noopener">Read the review</a>` : ""}</div></article>`).join("");
  }
  if (rums.length) body += `<h2>Rumours, checked</h2>` + rums.map(r => `<article><span class="tag">${esc(r.st)}</span><h3>${esc(r.t)}</h3><div class="src">First reported by ${esc(r.src)} · ${esc(r.date)}</div></article>`).join("");
  if (written.length) body += `<h2>Latest ${esc(f.t)} news</h2>` + written.slice(0, 12).map(w => `<article><h3>${esc(w.hook || w.title)}</h3><p>${esc(w.sum)}</p><div class="src">${fmt(w.ts)} · Reported by <a href="${esc(w.realUrl || w.url)}" rel="nofollow noopener">${esc(w.source)}</a>${(w.also || []).length ? ` and ${w.also.length} other outlet${w.also.length > 1 ? "s" : ""}` : ""}</div></article>`).join("");
  else if (news.length) body += `<h2>Latest headlines</h2>` + news.slice(0, 8).map(w => `<article><h3>${esc(w.title)}</h3><div class="src">${fmt(w.ts)} · <a href="${esc(w.realUrl || w.url)}" rel="nofollow noopener">${esc(w.source)}</a></div></article>`).join("");
  const jsonld = { "@context": "https://schema.org", "@type": "Movie", name: f.t, inLanguage: "ta", url: `${SITE}/film/${id}.html`,
    ...(f.dir ? { director: { "@type": "Person", name: f.dir } } : {}), ...(f.cast ? { actor: f.cast.split(/,\s*/).map(n => ({ "@type": "Person", name: n })) } : {}),
    ...(f.gen ? { genre: f.gen } : {}), ...(f.d ? { datePublished: f.d } : {}), ...(P.poster ? { image: P.poster } : {}) };
  fs.writeFileSync(`film/${id}.html`, page({ path: `/film/${id}.html`, title, desc, body, image: P.backdrop || P.poster, jsonld, noindex: thin }));
  if (!thin) urls.push({ loc: `/film/${id}.html`, pri: "0.8", mod: news[0] ? new Date(news[0].ts).toISOString().slice(0, 10) : today });
}

// ---- release dates
const dated = filmIds.filter(id => F[id].d).sort((a, b) => F[a].d.localeCompare(F[b].d));
const up = dated.filter(id => F[id].d >= today), past = dated.filter(id => F[id].d < today).reverse().slice(0, 15);
const row = id => { const f = F[id]; return `<tr><td>${fmt(f.d)}</td><td><a href="/film/${id}.html">${esc(f.t)}</a><br><span class="src">${esc(f.cast || "")}</span></td><td>${f.conf ? "Confirmed" : "Expected"}</td></tr>`; };
const month = new Date().toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
fs.writeFileSync("tamil-movie-release-dates.html", page({
  path: "/tamil-movie-release-dates.html",
  title: `Tamil Movie Release Dates ${new Date().getUTCFullYear()}: Upcoming Kollywood Releases (${month}) | Unmai`,
  desc: `Upcoming Tamil movie release dates for ${month}, with confirmed and expected dates, cast and the latest news for each film. Updated every day.`,
  body: `<h1>Tamil movie release dates</h1><p class="sub">Updated ${fmt(Date.now())}. "Confirmed" means the makers announced it; "expected" means it is reported but not official.</p>
   <h2>Coming up</h2><table><tr><th>Date</th><th>Film</th><th>Status</th></tr>${up.map(row).join("") || `<tr><td colspan="3">No dates announced right now.</td></tr>`}</table>
   ${past.length ? `<h2>Recently released</h2><table><tr><th>Date</th><th>Film</th><th>Status</th></tr>${past.map(row).join("")}</table>` : ""}`,
  jsonld: { "@context": "https://schema.org", "@type": "ItemList", itemListElement: up.map((id, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/film/${id}.html`, name: F[id].t })) },
}));

// ---- sitemap + robots
fs.writeFileSync("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${SITE}${u.loc}</loc><lastmod>${u.mod || today}</lastmod><priority>${u.pri}</priority></url>`).join("\n")}\n</urlset>\n`);
fs.writeFileSync("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`pages: ${filmIds.length} film pages (${urls.length - 4} indexable), release dates, sitemap`);
