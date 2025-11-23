(() => {
  const YEAR_START = 1990;
  const YEAR_END = 2025;
  const LIGHT_PAGES = 1; // per year
  const DEEP_PAGES = 4;  // per year
  const CACHE_KEY = 'animeRangeCache_v1';
  const WATCHED_KEY = 'animeWatched_v1';
  const TRANSLATE_KEY = 'animeTranslateCache_v1';

  const els = {
    yearSelect: document.getElementById('yearSelect'),
    typeSelect: document.getElementById('typeSelect'),
    statusSelect: document.getElementById('statusSelect'),
    searchInput: document.getElementById('searchInput'),
    fetchYearBtn: document.getElementById('fetchYearBtn'),
    prefetchLight: document.getElementById('prefetchLight'),
    prefetchDeep: document.getElementById('prefetchDeep'),
    animeList: document.getElementById('animeList'),
    emptyState: document.getElementById('emptyState'),
    clearWatched: document.getElementById('clearWatched'),
    clearCache: document.getElementById('clearCache'),
    statLoaded: document.getElementById('statLoaded'),
    statWatched: document.getElementById('statWatched'),
    statCoverage: document.getElementById('statCoverage'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    translateProgressFill: document.getElementById('translateProgressFill'),
    translateProgressText: document.getElementById('translateProgressText'),
    downloadBtn: document.getElementById('downloadBtn'),
    shareWatched: document.getElementById('shareWatched'),
    shareCoverage: document.getElementById('shareCoverage'),
    shareHotYear: document.getElementById('shareHotYear'),
    shareYearBars: document.getElementById('shareYearBars'),
  };

  const animeMap = new Map();
  const watched = new Set(loadJSON(WATCHED_KEY, []));
  const translateCache = loadJSON(TRANSLATE_KEY, {});
  const translateQueue = new Set();
  let translateInFlight = 0;
  let translateTotal = 0;
  updateTranslateProgress();

  initYearOptions();
  loadCache();
  bindEvents();
  render();

  function bindEvents() {
    els.fetchYearBtn.addEventListener('click', () => fetchSelectedYear(LIGHT_PAGES));
    els.prefetchLight.addEventListener('click', () => prefetchRange(LIGHT_PAGES));
    els.prefetchDeep.addEventListener('click', () => prefetchRange(DEEP_PAGES));
    els.typeSelect.addEventListener('change', render);
    els.statusSelect.addEventListener('change', render);
    els.searchInput.addEventListener('input', debounce(render, 120));
    els.yearSelect.addEventListener('change', render);
    els.clearWatched.addEventListener('click', clearWatchedMarks);
    els.clearCache.addEventListener('click', clearCache);
    els.downloadBtn.addEventListener('click', downloadShareCard);
  }

  function initYearOptions() {
    for (let y = YEAR_END; y >= YEAR_START; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = y;
      els.yearSelect.appendChild(opt);
    }
    els.yearSelect.value = String(YEAR_END);
  }

  function loadCache() {
    const cached = loadJSON(CACHE_KEY, []);
    cached.forEach(item => animeMap.set(item.id, item));
  }

  function saveCache() {
    const data = Array.from(animeMap.values());
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  async function fetchSelectedYear(pages) {
    const year = Number(els.yearSelect.value);
    await fetchYear(year, pages);
    render();
  }

  async function prefetchRange(pagesPerYear) {
    disableControls(true);
    let processed = 0;
    const total = (YEAR_END - YEAR_START + 1);

    for (let y = YEAR_END; y >= YEAR_START; y--) {
      els.progressText.textContent = `拉取 ${y} 年(${processed + 1}/${total})`;
      await fetchYear(y, pagesPerYear);
      processed++;
      const ratio = Math.round((processed / total) * 100);
      els.progressFill.style.width = `${ratio}%`;
    }

    els.progressText.textContent = '完成';
    disableControls(false);
    render();
  }

  function disableControls(disabled) {
    [
      els.fetchYearBtn,
      els.prefetchLight,
      els.prefetchDeep,
      els.downloadBtn,
    ].forEach(btn => btn.disabled = disabled);
  }

  async function fetchYear(year, pages) {
    for (let page = 1; page <= pages; page++) {
      // hottest first: high score first
      const url = `https://api.jikan.moe/v4/anime?start_date=${year}-01-01&end_date=${year}-12-31&order_by=score&sort=desc&limit=25&page=${page}`;
      try {
        const items = await fetchWithRetry(url, 4);
        if (items && items.length) {
          items.forEach(item => animeMap.set(item.id, item));
          items.forEach(item => maybeTranslateTitle(item.id, item.title));
          saveCache();
          els.statLoaded.textContent = animeMap.size;
        }
        await sleep(500); // gentle throttle
      } catch (e) {
        console.error('请求异常', e);
        els.progressText.textContent = `拉取 ${year} 年出错: ${e.message || e}`;
      }
    }
  }

  async function fetchWithRetry(url, retries = 3) {
    let delay = 800;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        return (json.data || []).map(normalizeAnime);
      }
      if (res.status === 429) {
        await sleep(delay);
        delay = Math.min(4000, Math.round(delay * 1.8));
        continue;
      }
      if (res.status === 400) {
        throw new Error('Jikan 返回 400，可能被限流或参数无效，稍后再试或减少并发');
      }
      if (attempt === retries) {
        throw new Error(`HTTP ${res.status}`);
      }
      await sleep(delay);
      delay = Math.min(4000, Math.round(delay * 1.6));
    }
    return [];
  }

  function normalizeAnime(row) {
    const year = extractYear(row);
    const title = pickBestTitle(row);
    return {
      id: row.mal_id,
      title,
      type: row.type || 'TV',
      status: row.status || '',
      year,
      episodes: row.episodes || '?',
      score: row.score || '?',
      image: row.images?.jpg?.image_url || row.images?.webp?.image_url || '',
      url: row.url,
      aired: row.aired?.string || '',
    };
  }

  function extractYear(row) {
    if (row.year) return row.year;
    const from = row.aired?.prop?.from;
    if (from && from.year) return from.year;
    const start = row.aired?.from;
    if (start) return new Date(start).getFullYear();
    return undefined;
  }

  function pickBestTitle(row) {
    const candidates = getTitleCandidates(row);
    const chinese = candidates.find(isChinese);
    if (chinese) return chinese;
    // take first available, will trigger translation
    return candidates[0] || 'Unknown';
  }

  function getTitleCandidates(row) {
    const titles = row.titles || [];
    const syns = row.title_synonyms || [];
    const set = new Set();
    const ordered = [
      ...titles.map(t => t?.title).filter(Boolean),
      row.title_english,
      row.title_japanese,
      row.title,
      ...syns.filter(Boolean),
    ].filter(Boolean);
    ordered.forEach(t => set.add(t));
    return Array.from(set);
  }

  function isChinese(str) {
    return /[\u4e00-\u9fa5]/.test(str);
  }

  function isJapanese(str) {
    return /[\u3040-\u30ff]/.test(str); // hiragana/katakana
  }

  function needsTranslation(str) {
    if (!str) return false;
    // translate any non-Chinese text that contains letters, kana, or other symbols
    return !isChinese(str) && /[^\u4e00-\u9fa5\s\d]/.test(str);
  }

  function maybeTranslateTitle(id, currentTitle) {
    if (!currentTitle || !needsTranslation(currentTitle)) return;
    if (translateCache[currentTitle]) {
      updateTitle(id, translateCache[currentTitle]);
      updateTranslateProgress();
      return;
    }
    if (translateQueue.has(currentTitle)) return;
    translateQueue.add(currentTitle);
    translateTotal += 1;
    translateInFlight += 1;
    updateTranslateProgress();
    translateToChinese(currentTitle).then(translated => {
      translateQueue.delete(currentTitle);
      translateInFlight = Math.max(0, translateInFlight - 1);
      if (!translated || translated === currentTitle || !isChinese(translated)) return;
      translateCache[currentTitle] = translated;
      localStorage.setItem(TRANSLATE_KEY, JSON.stringify(translateCache));
      updateTitle(id, translated);
    }).catch(() => {
      translateQueue.delete(currentTitle);
      translateInFlight = Math.max(0, translateInFlight - 1);
    }).finally(updateTranslateProgress);
  }

  function updateTitle(id, newTitle) {
    const item = animeMap.get(id);
    if (!item) return;
    item.title = newTitle;
    animeMap.set(id, item);
    render();
  }

  async function translateToChinese(text) {
    // First attempt: MyMemory
    const mem = await translateMyMemory(text);
    if (mem && isChinese(mem)) return mem;
    // Second attempt: Google unofficial endpoint
    const gg = await translateGoogle(text);
    if (gg && isChinese(gg)) return gg;
    return mem || gg || null;
  }

  async function translateMyMemory(text) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|zh-CN`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const translated = data?.responseData?.translatedText;
      if (translated && isChinese(translated)) return translated;
      const match = data?.matches?.find(m => m?.translation && isChinese(m.translation));
      return match ? match.translation : translated;
    } catch {
      return null;
    }
  }

  async function translateGoogle(text) {
    // Unofficial endpoint; may be rate-limited but usually works for small batches
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const translated = data?.[0]?.map(part => part?.[0]).join('');
      return translated || null;
    } catch {
      return null;
    }
  }

  function updateTranslateProgress() {
    const pending = translateQueue.size + translateInFlight;
    const done = Math.max(0, translateTotal - pending);
    const percent = translateTotal ? Math.min(100, Math.round((done / translateTotal) * 100)) : 100;
    if (els.translateProgressFill) {
      els.translateProgressFill.style.width = `${percent}%`;
    }
    if (els.translateProgressText) {
      els.translateProgressText.textContent = pending === 0
        ? '暂无待翻译'
        : `翻译中：${pending}，完成 ${done}/${translateTotal}`;
    }
  }

  function render() {
    const list = applyFilters();
    renderList(list);
    renderStats();
    renderShareCard();
    renderShareTable();
    // ensure visible items are queued for translation if still non-Chinese
    list.forEach(item => maybeTranslateTitle(item.id, item.title));
    updateTranslateProgress();
  }

  function applyFilters() {
    const year = Number(els.yearSelect.value);
    const type = els.typeSelect.value;
    const status = els.statusSelect.value;
    const keyword = els.searchInput.value.trim().toLowerCase();

    return Array.from(animeMap.values()).filter(item => {
      if (year && item.year && item.year !== year) return false;
      if (type && item.type !== type) return false;
      if (status && item.status !== status) return false;
      if (keyword && !`${item.title}`.toLowerCase().includes(keyword)) return false;
      return true;
    }).sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  function renderList(list) {
    els.animeList.innerHTML = '';
    if (!list.length) {
      els.emptyState.style.display = 'block';
      return;
    }
    els.emptyState.style.display = 'none';

    const dedup = new Set();
    list.forEach(item => {
      const key = `${(item.title || '').toLowerCase().trim()}-${item.year || ''}`;
      if (dedup.has(key)) return;
      dedup.add(key);
      const card = document.createElement('div');
      card.className = 'card anime-card';

      const img = document.createElement('img');
      img.src = item.image || 'https://dummyimage.com/140x200/111827/ffffff&text=Anime';
      img.alt = item.title;

      const meta = document.createElement('div');
      meta.className = 'anime-meta';

      const h4 = document.createElement('h4');
      h4.textContent = item.title;

      const info = document.createElement('p');
      info.textContent = `${item.type} · ${item.year || '未知'} · 评分 ${item.score}`;

      const detail = document.createElement('p');
      detail.textContent = `${item.status || '状态未知'} · ${item.episodes} 话`;

      const tags = document.createElement('div');
      tags.className = 'tags';
      [item.year, item.type, item.status].filter(Boolean).forEach(t => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = t;
        tags.appendChild(span);
      });

      const watchBtn = document.createElement('button');
      watchBtn.className = 'watch-btn';
      watchBtn.textContent = watched.has(item.id) ? '已看过 ✓' : '标记已看';
      if (watched.has(item.id)) watchBtn.classList.add('watched');

      watchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWatched(item.id);
      });

      card.addEventListener('click', () => toggleWatched(item.id));

      meta.appendChild(h4);
      meta.appendChild(info);
      meta.appendChild(detail);
      meta.appendChild(tags);
      meta.appendChild(watchBtn);

      card.appendChild(img);
      card.appendChild(meta);
      els.animeList.appendChild(card);
    });
  }

  function toggleWatched(id) {
    if (watched.has(id)) {
      watched.delete(id);
    } else {
      watched.add(id);
    }
    localStorage.setItem(WATCHED_KEY, JSON.stringify(Array.from(watched)));
    render();
  }

  function clearWatchedMarks() {
    watched.clear();
    localStorage.removeItem(WATCHED_KEY);
    render();
  }

  function clearCache() {
    animeMap.clear();
    localStorage.removeItem(CACHE_KEY);
    render();
  }

  function renderStats() {
    const loaded = animeMap.size;
    const watchedCount = Array.from(watched).filter(id => animeMap.has(id)).length;
    const coverage = loaded ? ((watchedCount / loaded) * 100).toFixed(1) : 0;

    els.statLoaded.textContent = loaded;
    els.statWatched.textContent = watchedCount;
    els.statCoverage.textContent = `${coverage}%`;
  }

  function renderShareCard() {
    const loaded = animeMap.size;
    const watchedIds = Array.from(watched).filter(id => animeMap.has(id));
    const watchedCount = watchedIds.length;
    const coverage = loaded ? ((watchedCount / loaded) * 100).toFixed(1) : 0;

    const yearCounter = {};
    watchedIds.forEach(id => {
      const y = animeMap.get(id)?.year;
      if (!y) return;
      yearCounter[y] = (yearCounter[y] || 0) + 1;
    });
    const hot = Object.entries(yearCounter).sort((a, b) => b[1] - a[1])[0];

    els.shareWatched.textContent = watchedCount;
    els.shareCoverage.textContent = `${coverage}%`;
    els.shareHotYear.textContent = hot ? `${hot[0]} · ${hot[1]} 部` : '-';

    renderShareBars(yearCounter);
  }

  function renderShareTable() {
    const container = document.getElementById('shareTableContainer');
    container.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'share-table';
    const maxCols = 12;
    for (let y = YEAR_END; y >= YEAR_START; y--) {
      const items = Array.from(animeMap.values())
        .filter(i => i.year === y)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, maxCols);
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = y;
      tr.appendChild(th);
      for (let i = 0; i < maxCols; i++) {
        const td = document.createElement('td');
        const item = items[i];
        if (item) {
          td.textContent = item.title;
          if (watched.has(item.id)) td.classList.add('watched');
          maybeTranslateTitle(item.id, item.title);
        } else {
          td.textContent = '';
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    container.appendChild(table);
  }

  function renderShareBars(yearCounter) {
    els.shareYearBars.innerHTML = '';
    const years = Object.keys(yearCounter).map(Number).sort((a, b) => a - b);
    if (!years.length) {
      els.shareYearBars.innerHTML = '<p class="muted">还没有标记数据</p>';
      return;
    }
    const max = Math.max(...years.map(y => yearCounter[y]));
    years.slice(-12).forEach(y => {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const height = max ? Math.max(12, Math.round((yearCounter[y] / max) * 90)) : 12;
      bar.style.height = `${height}px`;
      const label = document.createElement('small');
      label.textContent = String(y).slice(2);
      bar.appendChild(label);
      els.shareYearBars.appendChild(bar);
    });
  }

  async function downloadShareCard() {
    const card = document.getElementById('shareTableCard');
    card.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.1)'; // ensure border in capture
    const canvas = await html2canvas(card, { backgroundColor: '#0b1018', useCORS: true });
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = 'anime-years-table.png';
    link.click();
  }

  function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }
})();

