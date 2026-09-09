const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

module.exports = function albumIndex(albums) {
 const cards = albums.map(({folder, title, subtitle, cover, count}, i) => `<a class="album" href="/gallery?folder=${encodeURIComponent(folder)}">
  <div class="cover">${cover ? `<img src="${escape(cover)}" alt="" loading="lazy" />` : '<span class="placeholder" aria-hidden="true">✺</span>'}<span class="number">${String(i + 1).padStart(2, '0')}</span></div>
  <div class="caption"><p class="eyebrow">${escape(subtitle || 'Ons reisdagboek')}</p><h2>${escape(title)}</h2><p class="open">${count ? `${count} ${count === 1 ? 'film' : 'films'} · Bekijk album` : 'Binnenkort · Bekijk album'} <span aria-hidden="true">↗</span></p></div>
 </a>`).join('');
 return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Onze vakantiealbums</title><link rel="stylesheet" href="/assets/album-index.css"></head>
 <body><header><a class="brand" href="/">VERDONK &amp; VAN GILS <span>herinneringen in beeld</span></a><a class="home" href="https://gerdjan.nl">GerdJan.nl ↗</a></header>
 <main><section class="intro"><p class="eyebrow">Samen op pad</p><h1>Even terug<br>naar <em>toen.</em></h1><p>De mooiste reizen, kleine avonturen en fijne momenten samen. Kies een album en beleef het nog een keer.</p></section>
 <section aria-labelledby="albums"><div class="section-heading"><h2 id="albums">Onze vakantiealbums</h2><span>${albums.length} ${albums.length === 1 ? 'album' : 'albums'}</span></div>${cards ? `<div class="grid">${cards}</div>` : '<p class="empty">Hier verzamelen we onze herinneringen. Het eerste album verschijnt binnenkort.</p>'}</section></main>
 <footer>Voor iedereen die erbij was. En iedereen die mee wil kijken.</footer></body></html>`;
};
