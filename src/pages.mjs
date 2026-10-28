// The static HTML of every page in every language, with the head tags search engines and link previews read, and
// the files crawlers ask for: sitemaps, robots.txt, llms.txt and each story as Markdown.
// Paths are relative to the folder a page's <base> names. URLs are absolute and come from site.yaml's url.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside a <script> element, with < escaped so a "</script>" in the content stays text
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c');
const pick = (field, lang, fallback) => field?.[lang] ?? field?.[fallback] ?? '';
// A line that opens with a number and a full stop is text, as Turkish ordinals are ("21. yüzyılda"), not a list item.
export const ordinals = md => md.replace(/^(\d+)\. /gm, '$1\\. ');
// a place the text names, linked to the page's marker by its id: [Gelibolu’ya](@gallipoli)
export const PLACE = /\[([^\]]+)\]\(@([^)\s]+)\)/g;

// a marker the template must hold. The function form keeps a "$&" in the value literal.
function fill(html, marker, value) {
  if (!html.includes(marker)) throw new Error(`template has no ${marker}`);
  return html.replace(marker, () => value);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = html => html.replace(/<[^>]+>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] !== '#' ? ENTITIES[e] ?? m : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))
  .replace(/\s+/g, ' ').trim();
const firstParagraph = html => plain(html.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '');

// A search snippet: the text up to its last sentence end before max characters, else cut at a space with an
// ellipsis. A sentence end in the first 60 characters is passed over, since it is often an abbreviation such as "c.".
export function describe(text, max = 160) {
  if (text.length <= max) return text;
  const ends = [...text.slice(0, max).matchAll(/[.!?…](?=\s)/g)].map(m => m.index + 1).filter(i => i >= 60);
  if (ends.length) return text.slice(0, ends.at(-1));
  const cut = text.lastIndexOf(' ', max - 2);
  return text.slice(0, cut > 0 ? cut : max - 2).replace(/[\s,;:]+$/, '') + '…';
}

// og:locale wants language_TERRITORY, and ICU supplies the likely territory: tr gives tr_TR
const ogLocale = l => { const m = new Intl.Locale(l).maximize(); return m.region ? `${m.language}_${m.region}` : m.language; };

// the <head> tags after the viewport: <base>, title and description always, the rest when the site has a URL
function head({ base, title, description, lang, site, canonical, alternates = [], type = 'website', image = null, jsonld = null }) {
  const tags = [`<base href="${base}">`, `<title>${esc(title)}</title>`];
  if (description) tags.push(`<meta name="description" content="${esc(description)}">`);
  if (!site.url) return tags.join('\n');
  tags.push(`<link rel="canonical" href="${esc(canonical)}">`);
  for (const a of alternates) tags.push(`<link rel="alternate" hreflang="${a.hreflang}" href="${esc(a.href)}">`);
  const og = { 'og:type': type, 'og:title': title, 'og:description': description, 'og:url': canonical, 'og:site_name': pick(site.title, lang, site.defaultLang), 'og:locale': ogLocale(lang) };
  for (const [k, v] of Object.entries(og)) if (v) tags.push(`<meta property="${k}" content="${esc(v)}">`);
  for (const a of alternates) if (a.hreflang !== lang && a.hreflang !== 'x-default') tags.push(`<meta property="og:locale:alternate" content="${ogLocale(a.hreflang)}">`);
  if (image) tags.push(`<meta property="og:image" content="${esc(image)}">`);
  tags.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  if (jsonld) tags.push(`<script type="application/ld+json">${scriptJson(jsonld)}</script>`);
  return tags.join('\n');
}

// one link per language version, plus x-default for readers whose language the page lacks
const alternatesFor = (site, langs, defaultLang, at) => site.url ? [...langs.map(l => ({ hreflang: l, href: site.abs(at(l)) })), { hreflang: 'x-default', href: site.abs(at(defaultLang)) }] : [];
const urlset = entries => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.map(e => `<url><loc>${esc(e.loc)}</loc>${e.alternates.map(a => `<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${esc(a.href)}"/>`).join('')}</url>`).join('\n')}
</urlset>
`;

// The site as the page builders use it: url ends in a slash, abs() turns a path from the site root into a URL.
export function siteContext({ url, title, languages, defaultLanguage }) {
  const base = url ? url.replace(/\/?$/, '/') : null;
  // abs keeps an absolute URL, such as an image's in the asset store, as it is
  return { url: base, title, langs: languages, defaultLang: defaultLanguage, abs: p => new URL(p, base).href, root: base ? new URL(base).pathname : '/' };
}

// Every file of one story folder: the bare and per language overviews, a page per step and language, the story as
// Markdown per language, and with a site URL its sitemap. bundle is what story.js carries. texts and images are
// per page id and language: the Markdown source, and the first image the text shows. links holds each image's
// original and og:image links, absolute or from the site root, and coverImage is the id of the story's cover.
export function storyFiles({ shell, bundle: B, texts, firstImages, links, coverImage = null, site: siteIn, versions }) {
  const site = { ...siteIn, title: B.site.title }, files = {}, id = B.id, langs = B.languages, def = B.defaultLanguage, pages = B.pages;
  const homeLang = l => site.langs.includes(l) ? l : site.defaultLang;
  // the Markdown file sits in the story folder, so a link from the site root goes one folder up
  const imageUrl = imgId => site.url ? site.abs(links[imgId].original) : /^https?:/.test(links[imgId].original) ? links[imgId].original : `../${links[imgId].original}`;
  const ogImage = imgId => site.url ? site.abs(links[imgId].og) : null;
  const cover = coverImage ? ogImage(coverImage) : null;
  const overviewAt = l => `${id}/${l}/`, stepAt = (l, pid) => `${id}/${l}/${pid}/`;

  const nav = (lang, cur) => {
    const L = f => pick(f, lang, def);
    const walk = (nodes, depth) => nodes.map(n => n.type === 'page'
      ? `<a class="pg" href="${lang}/${pages[n.index].id}/" style="--depth:${depth}"${n.index === cur ? ' aria-current="page"' : ''}><span class="d">${esc(L(pages[n.index].date))}</span>${esc(L(pages[n.index].title))}</a>`
      : `<details open><summary style="--depth:${depth}">${esc(L(n.title))}</summary>${walk(n.children, depth + 1)}</details>`).join('');
    return walk(B.tree, 0);
  };
  const page = ({ lang, base, route, headHtml, text, cur }) => {
    const L = f => pick(f, lang, def);
    let html = fill(shell, '<html lang="en">', `<html lang="${lang}" dir="${B.ui[lang].dir}">`);
    html = fill(html, '<!--__HEAD__-->', headHtml);
    html = fill(html, '<a class="back" id="back" href="../"></a>', `<a class="back" id="back" href="../${homeLang(lang)}/">${esc(L(B.site.title))}</a>`);
    html = fill(html, '<h1 id="title"></h1>', `<h1 id="title">${esc(L(B.title))}</h1>`);
    html = fill(html, '<nav class="pages" id="nav"></nav>', `<nav class="pages" id="nav">${nav(lang, cur)}</nav>`);
    html = fill(html, '<div class="text" id="story"></div>', `<div class="text" id="story">${text}</div>`);
    html = fill(html, 'const ROUTE = null;', `const ROUTE = ${scriptJson(route)};`);
    html = fill(html, 'src="story.js"', `src="story.js?v=${versions.story}"`);
    return fill(html, 'src="../harita.js"', `src="../harita.js?v=${versions.app}"`);
  };

  const overview = (lang, base, bare) => {
    const L = f => pick(f, lang, def), T = B.ui[lang];
    const canonical = site.url ? site.abs(overviewAt(lang)) : null;
    const text = `<div class="date">${esc(L(B.span))}</div><h2>${esc(L(B.title))}</h2>${B.summary ? `<p>${esc(L(B.summary))}</p>` : ''}`
      + `<p><a class="start" href="${lang}/${pages[0].id}/" data-page="0">${esc(T.start)}</a></p>`;
    const headHtml = head({ base, title: L(B.title), description: describe(L(B.summary)), lang, site, canonical,
      alternates: bare ? [] : alternatesFor(site, langs, def, overviewAt), image: cover });
    return page({ lang, base, route: bare ? null : { lang, page: null }, headHtml, text, cur: -1 });
  };
  files['index.html'] = overview(def, './', true);
  for (const lang of langs) files[`${lang}/index.html`] = overview(lang, '../', false);

  pages.forEach((p, i) => {
    for (const lang of langs) {
      const L = f => pick(f, lang, def), T = B.ui[lang];
      const description = describe(firstParagraph(p.html[lang]));
      const canonical = site.url ? site.abs(stepAt(lang, p.id)) : null;
      const image = firstImages[p.id]?.[lang] ? ogImage(firstImages[p.id][lang]) : cover;
      const sources = p.sources[lang].length ? `<h3>${esc(T.sources)}</h3><ol>${p.sources[lang].map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : '';
      const step = (j, label) => pages[j] ? `<a href="${lang}/${pages[j].id}/" data-page="${j}">${esc(label)}: ${esc(L(pages[j].title))}</a>` : '<span></span>';
      const text = `<div class="date">${esc(L(p.date))}</div><h2>${esc(L(p.title))}</h2>${p.html[lang]}${sources}<p class="steps">${step(i - 1, T.prev)}${step(i + 1, T.next)}</p>`;
      const title = `${L(p.title)} - ${L(B.title)}`;
      const jsonld = site.url && [
        { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
          [L(B.site.title), site.abs(`${homeLang(lang)}/`)], [L(B.title), site.abs(overviewAt(lang))], [L(p.title), canonical],
        ].map(([name, item], k) => ({ '@type': 'ListItem', position: k + 1, name, item })) },
        { '@context': 'https://schema.org', '@type': 'Article', headline: L(p.title), description, inLanguage: lang, url: canonical, mainEntityOfPage: canonical,
          ...(image ? { image } : {}), isPartOf: { '@type': 'CreativeWork', name: L(B.title), url: site.abs(overviewAt(lang)) },
          ...(p.sources[lang].length ? { citation: p.sources[lang] } : {}), publisher: { '@type': 'Organization', name: L(B.site.title), url: site.url } },
      ];
      const headHtml = head({ base: '../../', title, description, lang, site, canonical, alternates: alternatesFor(site, langs, def, l => stepAt(l, p.id)), type: 'article', image, jsonld });
      files[`${lang}/${p.id}/index.html`] = page({ lang, base: '../../', route: { lang, page: p.id }, headHtml, text, cur: i });
    }
  });

  for (const lang of langs) files[`${lang}.md`] = markdown(B, lang, texts, imageUrl);
  if (site.url) files['sitemap.xml'] = urlset([
    ...langs.map(l => ({ loc: site.abs(overviewAt(l)), alternates: alternatesFor(site, langs, def, overviewAt) })),
    ...pages.flatMap(p => langs.map(l => ({ loc: site.abs(stepAt(l, p.id)), alternates: alternatesFor(site, langs, def, k => stepAt(k, p.id)) }))),
  ]);
  return files;
}

// The story as one Markdown file: title and summary, then the groups as headings and each step with its date,
// text and sources. An @image line becomes a Markdown image.
function markdown(B, lang, texts, imageUrl) {
  const L = f => pick(f, lang, B.defaultLanguage), T = B.ui[lang], out = [`# ${L(B.title)}`, ''];
  if (B.summary) out.push(L(B.summary), '');
  const heading = depth => '#'.repeat(Math.min(depth + 2, 6));
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.type === 'group') { out.push(`${heading(depth)} ${L(n.title)}`, ''); walk(n.children, depth + 1); continue; }
      const p = B.pages[n.index];
      const text = ordinals(texts[p.id][lang]).replace(/^@image\s+(\S+)\s*$/gm, (_, imgId) => `![${L(B.images[imgId].caption).replace(/[[\]]/g, '\\$&')}](${imageUrl(imgId)})`)
        .replace(PLACE, '$1');
      out.push(`${heading(depth)} ${L(p.title)}`, '', `*${L(p.date)}*`, '', text.trim(), '');
      if (p.sources[lang].length) out.push(`${T.sources}:`, '', ...p.sources[lang].map(s => `- ${s}`), '');
    }
  };
  walk(B.tree, 0);
  return out.join('\n');
}

// The main page per language and bare at the root, the 404 page, and with a site URL the crawl files. data is
// what the main page script reads as SITE, cards the stories it lists. image is the og:image link of the first cover,
// absolute or from the site root.
export function siteFiles({ shell, data: S, image: imageIn = null, site: siteIn, common, themeCss, ui }) {
  const site = { ...siteIn, title: S.title }, files = {}, langs = S.languages, def = S.defaultLanguage;
  const storyLang = (s, l) => s.languages.includes(l) ? l : s.defaultLanguage;
  const homeAt = l => `${l}/`;
  const image = imageIn && site.url ? site.abs(imageIn) : null;

  const main = (lang, base, bare) => {
    const L = f => pick(f, lang, def), T = S.ui[lang];
    const rows = S.stories.map((s, i) => `
    <li class="row">
      <button type="button" aria-expanded="false" aria-controls="d-${i}" data-id="${esc(s.id)}">
        <span class="span">${esc(L(s.span))}</span><h2>${esc(L(s.title))}</h2><span class="chev"></span>
        <span class="brief">${esc(L(s.summary))}</span>
      </button>
      <div class="detail" id="d-${i}" hidden>
        <div>
          <p>${esc(L(s.summary))}</p>
          <div class="meta"><span>${s.pages} ${esc(T.pages)}</span><span>${esc(s.languages.map(l => S.ui[l]?.name ?? l).join(', '))}</span></div>
          <a class="open" href="${esc(s.id)}/${storyLang(s, lang)}/">${esc(T.open)}</a>
        </div>
        <div class="cover">${s.cover ? `<img src="${esc(s.cover)}" alt="">` : `<span>${esc(L(s.title))}</span>`}</div>
      </div>
    </li>`).join('');
    let html = fill(shell, '<html lang="en">', `<html lang="${lang}" dir="${T.dir}">`);
    html = fill(html, '<!--__HEAD__-->', head({ base, title: L(S.title), description: describe(L(S.intro)), lang, site,
      canonical: site.url ? site.abs(homeAt(lang)) : null, alternates: bare ? [] : alternatesFor(site, langs, def, homeAt), image }));
    html = fill(html, '<h1 id="title"></h1>', `<h1 id="title">${esc(L(S.title))}</h1>`);
    html = fill(html, '<p class="intro" id="intro"></p>', `<p class="intro" id="intro">${esc(L(S.intro))}</p>`);
    html = fill(html, '<ul class="rows" id="rows"></ul>', `<ul class="rows" id="rows">${rows}</ul>`);
    return fill(html, 'const SITE = null;', `const ROUTE = ${scriptJson(bare ? null : { lang })};\nconst SITE = ${scriptJson(S)};`);
  };
  files['index.html'] = main(def, './', true);
  for (const lang of langs) files[`${lang}/index.html`] = main(lang, '../', false);
  files['404.html'] = notFound({ S, site, common, themeCss, ui });

  if (site.url) {
    files['sitemap-main.xml'] = urlset(langs.map(l => ({ loc: site.abs(homeAt(l)), alternates: alternatesFor(site, langs, def, homeAt) })));
    files['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['sitemap-main.xml', ...S.stories.map(s => `${s.id}/sitemap.xml`)].map(f => `<sitemap><loc>${esc(site.abs(f))}</loc></sitemap>`).join('\n')}
</sitemapindex>
`;
    files['robots.txt'] = `User-agent: *\nAllow: /\n\nSitemap: ${site.abs('sitemap.xml')}\n`;
    const L = f => pick(f, def, def);
    files['llms.txt'] = [`# ${L(S.title)}`, '', ...(S.intro?.[def] ? [`> ${L(S.intro)}`, ''] : []),
      'Each story is one Markdown file per language: the title and summary, then every step with its date, text and sources.', '',
      '## Stories', '',
      ...S.stories.map(s => {
        const sl = storyLang(s, def), others = s.languages.filter(l => l !== sl);
        const also = others.length ? ` Also in ${others.map(l => `[${S.ui[l]?.name ?? l}](${site.abs(`${s.id}/${l}.md`)})`).join(', ')}.` : '';
        return `- [${pick(s.title, sl, s.defaultLanguage)}](${site.abs(`${s.id}/${sl}.md`)}): ${pick(s.summary, sl, s.defaultLanguage)}${also}`;
      }), ''].join('\n');
  }
  return files;
}

// GitHub Pages serves 404.html for any unknown path, at any depth, so its links start at the site root. The script
// reads the story and language from the path and shows the message in that language.
function notFound({ S, site, common, themeCss, ui }) {
  const def = S.defaultLanguage;
  const data = { root: site.root, languages: S.languages, defaultLanguage: def, title: S.title,
    ui: Object.fromEntries(Object.entries(ui).map(([l, u]) => [l, { not_found: u.not_found, dir: u.dir }])),
    stories: Object.fromEntries(S.stories.map(s => [s.id, { title: s.title, languages: s.languages, defaultLanguage: s.defaultLanguage }])) };
  return `<!doctype html>
<html lang="${def}" dir="${ui[def].dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(ui[def].not_found)}</title>
<link rel="stylesheet" href="${site.root}vendor/fonts.css">
<style>
${themeCss}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Public Sans","Helvetica Neue",Arial,sans-serif;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:4rem 1rem}
h1{font-family:"Fraunces",Georgia,serif;font-size:2rem;margin:0 0 1rem}
a{color:var(--accent)}
li{margin-bottom:.5rem}
</style>
</head>
<body>
<main>
<h1 id="msg">${esc(ui[def].not_found)}</h1>
<ul id="links"><li><a href="${esc(site.root)}${def}/">${esc(pick(S.title, def, def))}</a></li></ul>
</main>
<script>
${common}
const D = ${scriptJson(data)};
const path = decodeURIComponent(location.pathname), parts = path.slice(path.startsWith(D.root) ? D.root.length : 1).split('/').filter(Boolean);
const story = D.stories[parts[0]], asked = story ? parts[1] : parts[0];
const lang = (story ? story.languages : D.languages).includes(asked) ? asked : preferredLang(D.languages, D.defaultLanguage);
const home = D.languages.includes(lang) ? lang : D.defaultLanguage;
const L = field => pick(field, lang, D.defaultLanguage);
document.documentElement.lang = lang; document.documentElement.dir = D.ui[lang].dir;
document.title = $('msg').textContent = D.ui[lang].not_found;
$('links').innerHTML = (story ? \`<li><a href="\${esc(D.root + parts[0])}/\${story.languages.includes(lang) ? lang : story.defaultLanguage}/">\${esc(L(story.title))}</a></li>\` : '')
  + \`<li><a href="\${esc(D.root + home)}/">\${esc(L(D.title))}</a></li>\`;
</script>
</body>
</html>
`;
}
