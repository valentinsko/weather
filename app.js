/* ======================================================================
   Meteum — app.js
   ====================================================================== */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PROVIDERS = window.METEUM_PROVIDERS;
  const { circularMean, severityRank } = window.METEUM_UTIL;

  // ---- state ------------------------------------------------------------

  const state = {
    city: null,
    units: 'metric',
    enabledProviders: {},
    keys: { owm: '', wapi: '' },
    activeHourlyParam: 'weather',
    activeDailyParam: 'weather',
    data: {},
    rvMap: null,
    rvLayer: null,
  };

  // ---- LS helpers -------------------------------------------------------

  const LS_KEY = 'meteum.v1';

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.city) state.city = saved.city;
      if (saved.units) state.units = saved.units;
      if (saved.enabledProviders) state.enabledProviders = saved.enabledProviders;
      if (saved.keys) state.keys = { ...state.keys, ...saved.keys };
    } catch (e) { /* ignore */ }
  }

  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        city: state.city,
        units: state.units,
        enabledProviders: state.enabledProviders,
        keys: state.keys,
      }));
    } catch (e) { /* ignore */ }
  }

  // ---- units ------------------------------------------------------------

  function fmtTemp(v) {
    if (v == null || isNaN(v)) return '—';
    if (state.units === 'imperial') return `${(v * 9 / 5 + 32).toFixed(0)}°`;
    return `${Math.round(v)}°`;
  }

  function fmtWind(v) {
    if (v == null || isNaN(v)) return '—';
    if (state.units === 'imperial') return `${(v * 2.23694).toFixed(0)} mph`;
    return `${v.toFixed(1)} м/сек`;
  }

  function fmtPrec(v) {
    if (v == null || isNaN(v)) return '—';
    if (v === 0) return '0';
    if (state.units === 'imperial') return `${(v / 25.4).toFixed(2)} in`;
    return `${v.toFixed(1)} мм`;
  }

  // hPa → мм рт. ст. (1 hPa ≈ 0.7501 mmHg). В России традиционно мм рт. ст.
  function fmtPressure(v) {
    if (v == null || isNaN(v)) return '—';
    if (state.units === 'imperial') {
      // inches of mercury
      return `${(v * 0.02953).toFixed(2)} inHg`;
    }
    return `${Math.round(v * 0.750062)} мм рт. ст.`;
  }

  function fmtHumidity(v) {
    if (v == null || isNaN(v)) return '—';
    return `${Math.round(v)}%`;
  }

  function fmtDir(v) {
    if (v == null || isNaN(v)) return '—';
    const dirs = ['С','ССВ','СВ','ВСВ','В','ВЮВ','ЮВ','ЮЮВ','Ю','ЮЮЗ','ЮЗ','ЗЮЗ','З','ЗСЗ','СЗ','ССЗ'];
    const idx = Math.round(((v % 360) / 22.5)) % 16;
    return `${dirs[idx]} ${Math.round(v)}°`;
  }

  // ---- weather labels & icons ------------------------------------------

  const WEATHER_LABELS = {
    clear:               { day: 'ясно',         night: 'ясно',        sym: ['☀','☾'] },
    mostly_clear:        { day: 'малооблачно',  night: 'малооблачно', sym: ['🌤','🌙'] },
    partly_cloudy:       { day: 'переменная облачность', night: 'переменная облачность', sym: ['⛅','☁'] },
    cloudy:              { day: 'пасмурно',     night: 'пасмурно',    sym: ['☁','☁'] },
    fog:                 { day: 'туман',        night: 'туман',       sym: ['🌫','🌫'] },
    drizzle:             { day: 'морось',       night: 'морось',      sym: ['🌦','🌧'] },
    freezing_drizzle:    { day: 'ледяная морось', night: 'ледяная морось', sym: ['🌧','🌧'] },
    rain:                { day: 'дождь',        night: 'дождь',       sym: ['🌧','🌧'] },
    rain_showers:        { day: 'ливень',       night: 'ливень',      sym: ['🌦','🌧'] },
    freezing_rain:       { day: 'ледяной дождь', night: 'ледяной дождь', sym: ['🌧','🌧'] },
    snow:                { day: 'снег',         night: 'снег',        sym: ['🌨','🌨'] },
    snow_showers:        { day: 'снежные ливни', night: 'снежные ливни', sym: ['🌨','🌨'] },
    sleet:               { day: 'мокрый снег',  night: 'мокрый снег', sym: ['🌨','🌨'] },
    hail:                { day: 'град',         night: 'град',        sym: ['🌨','🌨'] },
    thunderstorm:        { day: 'гроза',        night: 'гроза',       sym: ['⛈','⛈'] },
    thunderstorm_hail:   { day: 'гроза с градом', night: 'гроза с градом', sym: ['⛈','⛈'] },
    unknown:             { day: '—',            night: '—',           sym: ['','']},
  };

  const SEVERITY_PREFIX = {
    light:    'небольш',     // согласование руками: «небольшой дождь / небольшая морось»
    moderate: '',
    heavy:    'сильн',
  };

  // словарь для согласования по роду
  const WEATHER_GENDER = {
    drizzle: 'f', freezing_drizzle: 'f', rain: 'm', rain_showers: 'm',
    freezing_rain: 'm', snow: 'm', snow_showers: 'm', sleet: 'm', hail: 'm',
    thunderstorm: 'f', thunderstorm_hail: 'f',
  };

  function weatherText(kind, severity, isDay) {
    const lbl = WEATHER_LABELS[kind] || WEATHER_LABELS.unknown;
    const base = isDay === false ? lbl.night : lbl.day;
    if (!severity || severity === 'moderate') return base;
    const stem = SEVERITY_PREFIX[severity];
    if (!stem) return base;
    const g = WEATHER_GENDER[kind];
    let prefix;
    if (g === 'f') prefix = stem + 'ая';
    else if (g === 'm') prefix = stem + 'ий';
    else return base;
    return `${prefix} ${base}`;
  }

  function weatherIcon(kind, isDay) {
    const lbl = WEATHER_LABELS[kind] || WEATHER_LABELS.unknown;
    return isDay === false ? lbl.sym[1] : lbl.sym[0];
  }

  // отдельная иконка ночь/день — заменим солнечные на лунные
  // Тут эмодзи ограничивают: ☀→☾, ⛅→🌙, 🌤→🌙, 🌦/🌧/🌨/⛈/🌫 — одинаково днём/ночью
  function weatherIconV2(kind, isDay) {
    if (isDay === false) {
      const map = {
        clear: '☾',
        mostly_clear: '🌙',
        partly_cloudy: '☁',
        cloudy: '☁',
      };
      if (map[kind]) return map[kind];
    } else {
      const map = {
        clear: '☀',
        mostly_clear: '🌤',
        partly_cloudy: '⛅',
        cloudy: '☁',
      };
      if (map[kind]) return map[kind];
    }
    return weatherIcon(kind, isDay);
  }

  // ---- statistics: median for ensemble averaging ----

  function median(arr) {
    const xs = arr.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = xs.length >> 1;
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  // мода (самое частое значение) — для категориальных типа weather_kind
  function mode(arr) {
    const xs = arr.filter(Boolean);
    if (!xs.length) return null;
    const counts = {};
    for (const v of xs) counts[v] = (counts[v] || 0) + 1;
    let best = null, bestN = 0;
    for (const k in counts) {
      if (counts[k] > bestN) { bestN = counts[k]; best = k; }
    }
    return best;
  }

  // ---- toast ------------------------------------------------------------

  let toastTimeout = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---- geocoding (Open-Meteo) -------------------------------------------

  async function geocode(query) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=ru&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('geocode failed');
    const j = await res.json();
    return j.results || [];
  }

  // ---- search UI --------------------------------------------------------

  const cityInput = $('#city-input');
  const suggestEl = $('#suggest');
  let suggestActiveIdx = -1;
  let suggestItems = [];
  let geoTimer = null;

  cityInput.addEventListener('input', () => {
    clearTimeout(geoTimer);
    const q = cityInput.value.trim();
    if (q.length < 2) { hideSuggest(); return; }
    geoTimer = setTimeout(async () => {
      try {
        const items = await geocode(q);
        renderSuggest(items);
      } catch (e) { hideSuggest(); }
    }, 200);
  });

  cityInput.addEventListener('keydown', (e) => {
    if (suggestEl.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suggestActiveIdx = Math.min(suggestActiveIdx + 1, suggestItems.length - 1);
      updateSuggestActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      suggestActiveIdx = Math.max(suggestActiveIdx - 1, 0);
      updateSuggestActive();
    } else if (e.key === 'Enter' && suggestActiveIdx >= 0) {
      e.preventDefault();
      pickCity(suggestItems[suggestActiveIdx]);
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-form')) hideSuggest();
  });

  function renderSuggest(items) {
    suggestItems = items;
    suggestActiveIdx = -1;
    if (!items.length) { hideSuggest(); return; }
    suggestEl.innerHTML = items.map((it, i) => `
      <li data-idx="${i}">
        <span>${escapeHtml(it.name)}${it.admin1 ? ', ' + escapeHtml(it.admin1) : ''}</span>
        <span class="country">${escapeHtml(it.country_code || '')}</span>
      </li>
    `).join('');
    suggestEl.hidden = false;
    $$('#suggest li').forEach(li => {
      li.addEventListener('click', () => pickCity(items[+li.dataset.idx]));
    });
  }

  function updateSuggestActive() {
    $$('#suggest li').forEach((li, i) => li.classList.toggle('active', i === suggestActiveIdx));
  }

  function hideSuggest() { suggestEl.hidden = true; suggestItems = []; suggestActiveIdx = -1; }

  function pickCity(item) {
    state.city = {
      name: item.name,
      country: item.country,
      country_code: item.country_code,
      admin1: item.admin1,
      latitude: item.latitude,
      longitude: item.longitude,
      timezone: item.timezone,
    };
    cityInput.value = '';
    hideSuggest();
    saveState();
    loadAllAndRender();
  }

  $('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = cityInput.value.trim();
    if (!q) return;
    try {
      const items = await geocode(q);
      if (items.length) pickCity(items[0]);
      else toast('Ничего не нашлось', 'error');
    } catch (err) {
      toast('Не получилось найти город', 'error');
    }
  });

  // ---- providers loading ------------------------------------------------

  function activeProviders() {
    return PROVIDERS.filter(p => {
      if (state.enabledProviders[p.id] === false) return false;
      if (p.requiresKey) {
        const k = p.id === 'owm' ? state.keys.owm : p.id === 'wapi' ? state.keys.wapi : null;
        if (!k) return false;
      }
      if (state.enabledProviders[p.id] == null) return p.enabledByDefault;
      return true;
    });
  }

  async function loadAllAndRender() {
    if (!state.city) return;
    const { latitude, longitude } = state.city;

    renderHero();
    renderLoadingTables();
    renderMap();

    state.data = {};
    const providers = activeProviders();
    const omProviders = providers.filter(p => p.kind === 'open-meteo');
    const otherProviders = providers.filter(p => p.kind !== 'open-meteo');

    const tasks = [];

    // Open-Meteo — ВСЕ модели одним запросом (вместо 6–7 отдельных)
    if (omProviders.length) {
      tasks.push((async () => {
        try {
          const batch = await window.METEUM_OM.fetchOpenMeteoBatch(
            latitude, longitude,
            omProviders.map(p => ({ id: p.id, model: p.model }))
          );
          for (const p of omProviders) {
            const d = batch[p.id];
            state.data[p.id] = (d && (d.hourly?.length || d.current)) ? d : { error: 'no data' };
          }
        } catch (e) {
          console.warn('[open-meteo batch] failed:', e);
          for (const p of omProviders) state.data[p.id] = { error: String(e.message || e) };
        }
      })());
    }

    // Источники с ключами — каждый своим запросом
    for (const p of otherProviders) {
      tasks.push((async () => {
        try {
          const opts = {};
          if (p.id === 'owm') opts.apiKey = state.keys.owm;
          if (p.id === 'wapi') opts.apiKey = state.keys.wapi;
          state.data[p.id] = await p.fetch(latitude, longitude, opts);
        } catch (e) {
          console.warn(`[${p.id}] failed:`, e);
          state.data[p.id] = { error: String(e.message || e) };
        }
      })());
    }

    await Promise.all(tasks);

    renderHero();
    renderTables();
    renderRadarNow();

    // если ВСЕ источники отвалились — не оставляем немую пустоту
    const okCount = providers.filter(p => state.data[p.id] && !state.data[p.id].error).length;
    if (providers.length && okCount === 0) {
      toast('Не удалось загрузить данные ни из одного источника. Возможно, временный сбой сети или превышен лимит запросов — попробуйте обновить через минуту.', 'error');
    } else if (okCount < providers.length) {
      const failed = providers.length - okCount;
      console.warn(`${failed} из ${providers.length} источников не ответили`);
    }
  }

  // ---- rendering: hero --------------------------------------------------

  function renderHero() {
    if (!state.city) {
      $('#loc-name').innerHTML = '—';
      $('#loc-meta').textContent = 'выберите город, чтобы загрузить прогнозы';
      $('#hero-now').innerHTML = '';
      document.body.classList.remove('is-night');
      return;
    }

    const c = state.city;
    const place = `${c.name}${c.admin1 && c.admin1 !== c.name ? ', ' + c.admin1 : ''}`;
    $('#loc-name').innerHTML = `${escapeHtml(place)} <em>${escapeHtml(c.country_code || '')}</em>`;

    const providers = activeProviders();
    $('#loc-meta').textContent = `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)} · ${providers.length} источник${suffix(providers.length, ['', 'а', 'ов'])}`;

    const currents = providers.map(p => state.data[p.id]?.current).filter(Boolean);
    if (!currents.length) {
      $('#hero-now').innerHTML = '<span class="skeleton" style="width:140px;height:64px;display:block;border-radius:8px;"></span>';
      return;
    }

    const tempAvg = median(currents.map(c => c.temp));
    const feels = median(currents.map(c => c.feels_like));
    const wind = median(currents.map(c => c.wind_speed));
    const dir  = circularMean(currents.map(c => c.wind_direction).filter(v => v != null));
    const press = median(currents.map(c => c.pressure));
    const kindMode = mode(currents.map(c => c.weather_kind));
    const sevMode = mode(currents.map(c => c.severity));
    // is_day — мажоритарно
    const dayVotes = currents.map(c => c.is_day).filter(v => v != null);
    const isDay = dayVotes.length ? (dayVotes.filter(Boolean).length >= dayVotes.length / 2) : true;

    document.body.classList.toggle('is-night', !isDay);

    const phenom = weatherText(kindMode, sevMode, isDay);
    const icon = weatherIconV2(kindMode, isDay);

    $('#hero-now').innerHTML = `
      <div class="hero-icon">${icon}</div>
      <div class="big">${fmtTemp(tempAvg).replace('°','')}<sup>°</sup></div>
      <div class="small-stack">
        <span class="phenom">${escapeHtml(phenom)}</span>
        <span>ощущается <b>${fmtTemp(feels)}</b></span>
        <span>ветер <b>${fmtWind(wind)}</b> · ${fmtDir(dir)}</span>
        <span>давление <b>${fmtPressure(press)}</b></span>
      </div>
    `;
  }

  function suffix(n, forms) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
    return forms[2];
  }

  // ---- rendering: tables ------------------------------------------------

  const NOW_ROWS = [
    { id: 'weather',     label: 'Явление',          unit: '' },
    { id: 'temp',        label: 'Температура',      unit: '°' },
    { id: 'feels_like',  label: 'Ощущается как',    unit: '°' },
    { id: 'pressure',    label: 'Давление',         unit: 'мм рт. ст.' },
    { id: 'wind_speed',  label: 'Скорость ветра',   unit: 'м/сек' },
    { id: 'wind_dir',    label: 'Направление',      unit: '°' },
    { id: 'precipitation', label: 'Осадки',         unit: 'мм' },
  ];

  const HOURLY_TABS = [
    { id: 'weather',       label: 'Явление' },
    { id: 'temp',          label: 'Температура' },
    { id: 'feels_like',    label: 'Ощущается' },
    { id: 'precipitation', label: 'Осадки' },
    { id: 'wind_speed',    label: 'Ветер' },
    { id: 'pressure',      label: 'Давление' },
  ];

  const DAILY_TABS = [
    { id: 'weather',            label: 'Явление дня' },
    { id: 'temp_max_min',       label: 'Темп. (мин/макс)' },
    { id: 'feels_like_max_min', label: 'Ощущается (мин/макс)' },
    { id: 'precipitation_sum',  label: 'Сумма осадков' },
    { id: 'wind_speed_max',     label: 'Макс. ветер' },
  ];

  function renderLoadingTables() {
    ['#table-now', '#table-hourly', '#table-daily'].forEach(s => {
      $(s).innerHTML = `<tbody><tr><td class="empty" colspan="9">Загружаем данные…</td></tr></tbody>`;
    });
  }

  function renderTables() {
    renderNowTable();
    renderHourlyTabs();
    renderDailyTabs();
    renderHourlyTable();
    renderDailyTable();
  }

  // ---- NOW table --------------------------------------------------------

  function renderNowTable() {
    const providers = activeProviders().filter(p => state.data[p.id]?.current);
    if (!providers.length) {
      $('#table-now').innerHTML = `<tbody><tr><td class="empty" colspan="9">Нет доступных источников. Откройте настройки и проверьте, какие провайдеры включены.</td></tr></tbody>`;
      return;
    }

    const headers = providers.map(p =>
      `<th title="${escapeHtml(p.region)}">${escapeHtml(p.name)}</th>`
    ).join('');

    const body = NOW_ROWS.map(row => {
      const cells = providers.map(p => {
        const cur = state.data[p.id].current;
        return `<td>${formatNowCell(cur, row.id)}</td>`;
      });
      cells.push(`<td class="mean">${formatNowAvg(providers, row.id)}</td>`);
      return `
        <tr>
          <td class="row-label">${row.label}${row.unit ? `<span class="unit">${row.unit}</span>` : ''}</td>
          ${cells.join('')}
        </tr>`;
    }).join('');

    $('#table-now').innerHTML = `
      <thead><tr><th></th>${headers}<th class="col-mean">Среднее</th></tr></thead>
      <tbody>${body}</tbody>
    `;
  }

  function formatNowCell(cur, paramId) {
    if (paramId === 'weather') {
      const txt = weatherText(cur.weather_kind, cur.severity, cur.is_day);
      const icon = weatherIconV2(cur.weather_kind, cur.is_day);
      return `<span class="phenom-cell"><span class="ph-ico">${icon}</span>${escapeHtml(txt)}</span>`;
    }
    if (paramId === 'temp')         return fmtTemp(cur.temp);
    if (paramId === 'feels_like')   return fmtTemp(cur.feels_like);
    if (paramId === 'pressure')     return fmtPressure(cur.pressure);
    if (paramId === 'wind_speed')   return fmtWind(cur.wind_speed);
    if (paramId === 'wind_dir')     return fmtDir(cur.wind_direction);
    if (paramId === 'precipitation') return fmtPrec(cur.precipitation);
    return '—';
  }

  function formatNowAvg(providers, paramId) {
    const currents = providers.map(p => state.data[p.id].current).filter(Boolean);
    if (paramId === 'weather') {
      const k = mode(currents.map(c => c.weather_kind));
      const s = mode(currents.map(c => c.severity));
      const dayVotes = currents.map(c => c.is_day).filter(v => v != null);
      const isDay = dayVotes.length ? (dayVotes.filter(Boolean).length >= dayVotes.length / 2) : true;
      const txt = weatherText(k, s, isDay);
      const icon = weatherIconV2(k, isDay);
      return `<span class="phenom-cell"><span class="ph-ico">${icon}</span>${escapeHtml(txt)}</span>`;
    }
    if (paramId === 'wind_dir') {
      const dirs = currents.map(c => c.wind_direction).filter(v => v != null);
      return fmtDir(dirs.length ? circularMean(dirs) : null);
    }
    const map = {
      temp: c => c.temp, feels_like: c => c.feels_like,
      pressure: c => c.pressure, wind_speed: c => c.wind_speed,
      precipitation: c => c.precipitation,
    };
    const fmt = {
      temp: fmtTemp, feels_like: fmtTemp,
      pressure: fmtPressure, wind_speed: fmtWind,
      precipitation: fmtPrec,
    }[paramId];
    return fmt(median(currents.map(map[paramId])));
  }

  // ---- HOURLY -----------------------------------------------------------

  function renderHourlyTabs() {
    $('#hourly-tabs').innerHTML = HOURLY_TABS.map(t => `
      <button data-param="${t.id}" class="${t.id === state.activeHourlyParam ? 'active' : ''}">${t.label}</button>
    `).join('');
    $$('#hourly-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        state.activeHourlyParam = b.dataset.param;
        renderHourlyTabs();
        renderHourlyTable();
      });
    });
  }

  function renderHourlyTable() {
    const providers = activeProviders().filter(p => state.data[p.id]?.hourly?.length);
    if (!providers.length) {
      $('#table-hourly').innerHTML = `<tbody><tr><td class="empty" colspan="2">Нет данных по часам.</td></tr></tbody>`;
      return;
    }

    const baseHourly = state.data[providers[0].id].hourly;
    const now = Date.now();
    let startIdx = baseHourly.findIndex(h => new Date(h.time).getTime() >= now - 30 * 60 * 1000);
    if (startIdx < 0) startIdx = 0;
    const hours = baseHourly.slice(startIdx, startIdx + 24);

    const headers = providers.map(p =>
      `<th title="${escapeHtml(p.region)}">${escapeHtml(p.name)}</th>`
    ).join('');

    const body = hours.map((h, hi) => {
      const t = new Date(h.time);
      const isNow = hi === 0;
      const timeLabel = `<td class="row-label ${isNow ? 'col-now' : ''}">${formatHour(t)}</td>`;

      // выберем для каждого провайдера ближайшую точку времени
      const matched = providers.map(p => {
        const ph = state.data[p.id].hourly;
        const target = t.getTime();
        let best = null, bestDiff = Infinity;
        for (const pt of ph) {
          const d = Math.abs(new Date(pt.time).getTime() - target);
          if (d < bestDiff) { bestDiff = d; best = pt; }
        }
        return (best && bestDiff <= 90 * 60 * 1000) ? best : null;
      });

      const cells = matched.map(pt => `<td class="${isNow ? 'col-now' : ''}">${formatHourlyCell(pt, state.activeHourlyParam)}</td>`);
      cells.push(`<td class="mean ${isNow ? 'col-now' : ''}">${formatHourlyAvg(matched, state.activeHourlyParam)}</td>`);

      return `<tr>${timeLabel}${cells.join('')}</tr>`;
    }).join('');

    $('#table-hourly').innerHTML = `
      <thead><tr><th>Время</th>${headers}<th class="col-mean">Среднее</th></tr></thead>
      <tbody>${body}</tbody>
    `;
  }

  function formatHourlyCell(pt, paramId) {
    if (!pt) return '—';
    if (paramId === 'weather') {
      const txt = weatherText(pt.weather_kind, pt.severity, pt.is_day);
      const icon = weatherIconV2(pt.weather_kind, pt.is_day);
      return `<span class="phenom-cell"><span class="ph-ico">${icon}</span>${escapeHtml(txt)}</span>`;
    }
    if (paramId === 'temp')          return fmtTemp(pt.temp);
    if (paramId === 'feels_like')    return fmtTemp(pt.feels_like);
    if (paramId === 'pressure')      return fmtPressure(pt.pressure);
    if (paramId === 'wind_speed')    return fmtWind(pt.wind_speed);
    if (paramId === 'precipitation') return fmtPrec(pt.precipitation);
    return '—';
  }

  function formatHourlyAvg(matched, paramId) {
    const valid = matched.filter(Boolean);
    if (!valid.length) return '—';
    if (paramId === 'weather') {
      const k = mode(valid.map(p => p.weather_kind));
      const s = mode(valid.map(p => p.severity));
      const dayVotes = valid.map(p => p.is_day).filter(v => v != null);
      const isDay = dayVotes.length ? (dayVotes.filter(Boolean).length >= dayVotes.length / 2) : true;
      const txt = weatherText(k, s, isDay);
      const icon = weatherIconV2(k, isDay);
      return `<span class="phenom-cell"><span class="ph-ico">${icon}</span>${escapeHtml(txt)}</span>`;
    }
    const get = {
      temp: p => p.temp, feels_like: p => p.feels_like,
      pressure: p => p.pressure, wind_speed: p => p.wind_speed,
      precipitation: p => p.precipitation,
    }[paramId];
    const fmt = {
      temp: fmtTemp, feels_like: fmtTemp,
      pressure: fmtPressure, wind_speed: fmtWind,
      precipitation: fmtPrec,
    }[paramId];
    return fmt(median(valid.map(get)));
  }

  function formatHour(d) {
    const today = new Date();
    const dayLabel = (d.getDate() === today.getDate() && d.getMonth() === today.getMonth())
      ? 'сегодня'
      : (() => {
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);
          if (d.getDate() === tomorrow.getDate() && d.getMonth() === tomorrow.getMonth()) return 'завтра';
          return ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()];
        })();
    return `${dayLabel} ${String(d.getHours()).padStart(2, '0')}:00`;
  }

  // ---- DAILY ------------------------------------------------------------

  function renderDailyTabs() {
    $('#daily-tabs').innerHTML = DAILY_TABS.map(t => `
      <button data-param="${t.id}" class="${t.id === state.activeDailyParam ? 'active' : ''}">${t.label}</button>
    `).join('');
    $$('#daily-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        state.activeDailyParam = b.dataset.param;
        renderDailyTabs();
        renderDailyTable();
      });
    });
  }

  function renderDailyTable() {
    const providers = activeProviders().filter(p => state.data[p.id]?.daily?.length);
    if (!providers.length) {
      $('#table-daily').innerHTML = `<tbody><tr><td class="empty" colspan="2">Нет суточных данных.</td></tr></tbody>`;
      return;
    }

    const baseDaily = state.data[providers[0].id].daily;
    const days = baseDaily.slice(0, 7);

    const headers = providers.map(p =>
      `<th title="${escapeHtml(p.region)}">${escapeHtml(p.name)}</th>`
    ).join('');

    const k = state.activeDailyParam;

    const body = days.map((day) => {
      const dt = new Date(day.date);
      const dayLabel = `<td class="row-label">${formatDay(dt)}</td>`;

      const values = providers.map(p => {
        const pd = state.data[p.id].daily.find(x => x.date === day.date);
        return pd || null;
      });

      let cells, avgCell;

      if (k === 'weather') {
        cells = values.map(d => {
          if (!d) return '<td class="absent">—</td>';
          const txt = weatherText(d.weather_kind, d.severity, true);
          const icon = weatherIconV2(d.weather_kind, true);
          return `<td><span class="phenom-cell"><span class="ph-ico">${icon}</span>${escapeHtml(txt)}</span></td>`;
        });
        const valid = values.filter(Boolean);
        const avgK = mode(valid.map(d => d.weather_kind));
        const avgS = mode(valid.map(d => d.severity));
        const txt = weatherText(avgK, avgS, true);
        const icon = weatherIconV2(avgK, true);
        avgCell = `<td class="mean"><span class="phenom-cell"><span class="ph-ico">${icon}</span>${escapeHtml(txt)}</span></td>`;
      } else if (k === 'temp_max_min') {
        cells = values.map(d => `<td>${d ? `${fmtTemp(d.temp_min)} / ${fmtTemp(d.temp_max)}` : '—'}</td>`);
        const avgMin = median(values.map(d => d?.temp_min));
        const avgMax = median(values.map(d => d?.temp_max));
        avgCell = `<td class="mean">${fmtTemp(avgMin)} / ${fmtTemp(avgMax)}</td>`;
      } else if (k === 'feels_like_max_min') {
        cells = values.map(d => {
          if (!d || (d.feels_like_min == null && d.feels_like_max == null)) return '<td class="absent">—</td>';
          return `<td>${fmtTemp(d.feels_like_min)} / ${fmtTemp(d.feels_like_max)}</td>`;
        });
        const avgMin = median(values.map(d => d?.feels_like_min));
        const avgMax = median(values.map(d => d?.feels_like_max));
        avgCell = `<td class="mean">${fmtTemp(avgMin)} / ${fmtTemp(avgMax)}</td>`;
      } else if (k === 'precipitation_sum') {
        cells = values.map(d => `<td>${d ? fmtPrec(d.precipitation_sum) : '—'}</td>`);
        avgCell = `<td class="mean">${fmtPrec(median(values.map(d => d?.precipitation_sum)))}</td>`;
      } else {
        cells = values.map(d => `<td>${d ? fmtWind(d.wind_speed_max) : '—'}</td>`);
        avgCell = `<td class="mean">${fmtWind(median(values.map(d => d?.wind_speed_max)))}</td>`;
      }

      return `<tr>${dayLabel}${cells.join('')}${avgCell}</tr>`;
    }).join('');

    $('#table-daily').innerHTML = `
      <thead><tr><th>День</th>${headers}<th class="col-mean">Среднее</th></tr></thead>
      <tbody>${body}</tbody>
    `;
  }

  function formatDay(d) {
    const today = new Date(); today.setHours(0,0,0,0);
    const dd = new Date(d); dd.setHours(0,0,0,0);
    const diffDays = Math.round((dd - today) / 86400000);
    const dayNames = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    const monthNames = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
    const prefix = diffDays === 0 ? 'сегодня' : diffDays === 1 ? 'завтра' : dayNames[d.getDay()];
    return `${prefix} <span style="color:var(--text-dim)">${d.getDate()} ${monthNames[d.getMonth()]}</span>`;
  }

  // ---- MAP: RainViewer + Leaflet ---------------------------------------
  // RainViewer бесплатный публичный API, без ключа, глобальное покрытие.
  // https://www.rainviewer.com/api.html

  // --- общий кэш индекса RainViewer (используется картой и точечным радаром) ---
  let _rvCache = null;
  async function getRainViewerIndex() {
    if (_rvCache && (Date.now() - _rvCache.t) < 5 * 60 * 1000) return _rvCache.data;
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!r.ok) throw new Error('rv index http');
    const data = await r.json();
    _rvCache = { t: Date.now(), data };
    return data;
  }

  // широта/долгота → номер тайла (z) + пиксель внутри тайла (256px)
  function latLonToTile(lat, lon, z) {
    const n = 2 ** z;
    const latRad = lat * Math.PI / 180;
    const xf = (lon + 180) / 360 * n;
    const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const x = Math.floor(xf), y = Math.floor(yf);
    return {
      x, y,
      px: Math.min(255, Math.max(0, Math.floor((xf - x) * 256))),
      py: Math.min(255, Math.max(0, Math.floor((yf - y) * 256))),
    };
  }

  // Сэмплируем радарный тайл в точке города → есть ли осадки ПРЯМО СЕЙЧАС.
  // Это наблюдение (радар+спутник), а не прогноз модели.
  async function sampleRadar(lat, lon) {
    const data = await getRainViewerIndex();
    const past = data.radar?.past || [];
    const frame = past[past.length - 1];      // самый свежий ИЗМЕРЕННЫЙ кадр
    if (!frame) throw new Error('no radar frame');

    const z = 7;
    const { x, y, px, py } = latLonToTile(lat, lon, z);
    // color scheme 4 (TWC) с чёткими ступенями, без сглаживания (_0)
    const url = `${data.host}${frame.path}/256/${z}/${x}/${y}/4/1_0.png`;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('tile load failed'));
      img.src = url;
    });

    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    // окрестность ±3px (радар патчевый, точка может попасть между пикселями)
    let maxAlpha = 0, best = null;
    const R = 3;
    const x0 = Math.max(0, px - R), y0 = Math.max(0, py - R);
    const w = Math.min(256, px + R + 1) - x0;
    const h = Math.min(256, py + R + 1) - y0;
    const region = ctx.getImageData(x0, y0, w, h).data;
    for (let i = 0; i < region.length; i += 4) {
      const a = region[i + 3];
      if (a > maxAlpha) { maxAlpha = a; best = [region[i], region[i + 1], region[i + 2], a]; }
    }

    const precip = maxAlpha > 25;
    let intensity = null;
    if (precip && best) {
      const [r, g, b] = best;
      // палитра TWC: зелёный→жёлтый→оранжевый→красный→малиновый
      if (r > 170 && b > 120) intensity = 'heavy';          // малиновый (экстрим)
      else if (r > 180 && g < 150) intensity = 'heavy';     // красный
      else if (r > 170 && g > 150) intensity = 'moderate';  // жёлто-оранжевый
      else intensity = 'light';                              // зелёный/синий
    }
    return { precip, intensity, time: frame.time };
  }

  // Индикатор «сейчас по радару» — отдельно от прогнозной таблицы.
  async function renderRadarNow() {
    const strip = $('#radar-now');
    if (!strip) return;
    if (!state.city) { strip.hidden = true; return; }

    const { latitude, longitude } = state.city;

    // тип осадков (дождь/снег) прикинем по консенсусной температуре
    const currents = activeProviders().map(p => state.data[p.id]?.current).filter(Boolean);
    const tempAvg = median(currents.map(c => c.temp));

    try {
      const res = await sampleRadar(latitude, longitude);
      const ts = new Date(res.time * 1000);
      const hhmm = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;

      if (!res.precip) {
        strip.className = 'radar-strip radar-dry';
        strip.innerHTML = `
          <span class="radar-dot"></span>
          <span class="radar-text">По радару сейчас осадков нет</span>
          <span class="radar-meta">наблюдение · ${hhmm}</span>`;
        strip.hidden = false;
        return;
      }

      // дождь / мокрый снег / снег
      let type = 'дождь', icon = '🌧';
      if (tempAvg != null && tempAvg <= 0) { type = 'снег'; icon = '🌨'; }
      else if (tempAvg != null && tempAvg <= 2) { type = 'мокрый снег'; icon = '🌨'; }

      const intWord = res.intensity === 'heavy' ? 'сильный '
        : res.intensity === 'light' ? 'небольшой ' : '';
      // согласование: «небольшой дождь», но «небольшой снег»; для «мокрый снег» префикс не клеим
      const label = (type === 'мокрый снег') ? type : `${intWord}${type}`;

      strip.className = 'radar-strip radar-wet';
      strip.innerHTML = `
        <span class="radar-ico">${icon}</span>
        <span class="radar-text">По радару сейчас идёт ${escapeHtml(label)}</span>
        <span class="radar-meta">наблюдение · ${hhmm}</span>`;
      strip.hidden = false;
    } catch (e) {
      // радар недоступен (нет CORS / нет покрытия) — не показываем строку
      console.warn('radar nowcast unavailable:', e);
      strip.hidden = true;
    }
  }

  async function renderMap() {
    const el = $('#map-wrap');
    if (!state.city) {
      el.innerHTML = `<div class="map-fallback">Выберите город, чтобы увидеть карту осадков.</div>`;
      return;
    }
    if (typeof L === 'undefined') {
      el.innerHTML = `<div class="map-fallback">Не удалось загрузить библиотеку карт. Проверьте интернет.</div>`;
      return;
    }

    const { latitude, longitude } = state.city;

    // (пере)создаём карту полностью при смене города
    el.innerHTML = `<div id="rv-map"></div>`;

    const map = L.map('rv-map', {
      center: [latitude, longitude],
      zoom: 8,
      zoomControl: true,
      attributionControl: true,
    });
    state.rvMap = map;

    // тёмная подложка — CARTO Dark Matter (бесплатный и без ключа)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap, © CARTO',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // маркер города
    L.marker([latitude, longitude]).addTo(map)
      .bindPopup(state.city.name).openPopup();

    // RainViewer текущий слой
    try {
      const data = await getRainViewerIndex();
      // берём самый свежий доступный кадр
      const past = (data.radar?.past || []);
      const nowcast = (data.radar?.nowcast || []);
      const latest = nowcast[0] || past[past.length - 1];
      if (!latest) throw new Error('no frames');

      const host = data.host;
      // colorScheme=2 — стандартная (Original), size=512, snow=1
      const layerUrl = `${host}${latest.path}/512/{z}/{x}/{y}/2/1_1.png`;
      const rvLayer = L.tileLayer(layerUrl, {
        opacity: 0.7,
        attribution: '© RainViewer',
        maxZoom: 12,
      }).addTo(map);
      state.rvLayer = rvLayer;

      // легенда
      const legend = L.control({ position: 'bottomleft' });
      legend.onAdd = function () {
        const div = L.DomUtil.create('div', 'rv-legend');
        const ts = new Date(latest.time * 1000);
        const hh = String(ts.getHours()).padStart(2, '0');
        const mm = String(ts.getMinutes()).padStart(2, '0');
        div.innerHTML = `
          <div class="rv-legend-time">RainViewer · ${hh}:${mm}</div>
          <div class="rv-legend-bar">
            <span style="background:#01a2ff"></span>
            <span style="background:#00ff66"></span>
            <span style="background:#ffe800"></span>
            <span style="background:#ff8000"></span>
            <span style="background:#ff0000"></span>
            <span style="background:#a200ff"></span>
          </div>
          <div class="rv-legend-labels">
            <span>лёгкий</span><span>средний</span><span>сильный</span>
          </div>
        `;
        return div;
      };
      legend.addTo(map);
    } catch (err) {
      console.warn('RainViewer load failed:', err);
      const warn = L.control({ position: 'topright' });
      warn.onAdd = function () {
        const d = L.DomUtil.create('div', 'rv-warn');
        d.textContent = 'Слой осадков недоступен';
        return d;
      };
      warn.addTo(map);
    }
  }

  // ---- settings panel ---------------------------------------------------

  $('#settings-btn').addEventListener('click', () => {
    renderPanel();
    $('#panel').hidden = false;
  });
  $('#panel-close').addEventListener('click', () => { $('#panel').hidden = true; });
  $('#panel').addEventListener('click', (e) => {
    if (e.target.id === 'panel') $('#panel').hidden = true;
  });

  function renderPanel() {
    const togglesHtml = PROVIDERS
      .filter(p => !p.requiresKey)
      .map(p => {
        const checked = state.enabledProviders[p.id] !== false;
        return `
          <label class="model-toggle">
            <span><input type="checkbox" data-id="${p.id}" ${checked ? 'checked' : ''} /> ${escapeHtml(p.name)}</span>
            <span class="mt-region">${escapeHtml(p.region)}</span>
          </label>
        `;
      }).join('');
    $('#model-toggles').innerHTML = togglesHtml;

    $('#key-owm').value = state.keys.owm || '';
    $('#key-wapi').value = state.keys.wapi || '';

    $$('#units-seg button').forEach(b => {
      b.classList.toggle('active', b.dataset.units === state.units);
      b.onclick = () => {
        state.units = b.dataset.units;
        $$('#units-seg button').forEach(x => x.classList.toggle('active', x === b));
      };
    });
  }

  $('#save-settings').addEventListener('click', () => {
    $$('#model-toggles input').forEach(inp => {
      state.enabledProviders[inp.dataset.id] = inp.checked;
    });
    state.keys.owm = $('#key-owm').value.trim();
    state.keys.wapi = $('#key-wapi').value.trim();
    saveState();
    $('#panel').hidden = true;
    toast('Настройки сохранены', 'ok');
    if (state.city) loadAllAndRender();
    else { renderHero(); }
  });

  // ---- escape -----------------------------------------------------------

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  // ---- init -------------------------------------------------------------

  loadState();
  renderHero();
  if (state.city) {
    loadAllAndRender();
  } else {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=ru&format=json`;
          const r = await fetch(url);
          if (r.ok) {
            const j = await r.json();
            const top = (j.results && j.results[0]) || null;
            if (top) { pickCity(top); return; }
          }
          state.city = {
            name: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
            country: '', country_code: '', latitude, longitude,
          };
          saveState();
          loadAllAndRender();
        } catch (e) { /* ignore */ }
      }, () => { /* denied */ }, { timeout: 5000 });
    }
  }

})();
