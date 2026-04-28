/* ======================================================================
   Meteum — app.js
   ====================================================================== */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PROVIDERS = window.METEUM_PROVIDERS;
  const { circularMean } = window.METEUM_UTIL;

  // ---- state ------------------------------------------------------------

  const state = {
    city: null,                 // { name, country, latitude, longitude, timezone }
    units: 'metric',            // 'metric' | 'imperial'
    enabledProviders: {},       // { providerId: true }
    keys: { owm: '', wapi: '' },
    activeHourlyParam: 'temp',
    activeDailyParam: 'temp',
    data: {},                   // { providerId: ProviderData | { error } }
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
    return `${v.toFixed(1)} m/s`;
  }

  function fmtPrec(v) {
    if (v == null || isNaN(v)) return '—';
    if (v === 0) return '0';
    if (state.units === 'imperial') return `${(v / 25.4).toFixed(2)} in`;
    return `${v.toFixed(1)} мм`;
  }

  function fmtPressure(v) {
    if (v == null || isNaN(v)) return '—';
    return `${Math.round(v)} hPa`;
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

  // ---- statistics: median is more robust than mean for ensemble averaging

  function median(arr) {
    const xs = arr.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = xs.length >> 1;
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  function meanOf(arr) {
    const xs = arr.filter(v => v != null && !isNaN(v));
    if (!xs.length) return null;
    return xs.reduce((s, v) => s + v, 0) / xs.length;
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
        const key = state.keys[p.id === 'owm' ? 'owm' : p.id === 'wapi' ? 'wapi' : null];
        if (!key) return false;
      }
      // По умолчанию включены все open-meteo, кроме `om_best` (он совпадает с одним из других)
      if (state.enabledProviders[p.id] == null) {
        return p.enabledByDefault;
      }
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

    await Promise.all(providers.map(async (p) => {
      try {
        const opts = {};
        if (p.id === 'owm') opts.apiKey = state.keys.owm;
        if (p.id === 'wapi') opts.apiKey = state.keys.wapi;
        state.data[p.id] = await p.fetch(latitude, longitude, opts);
      } catch (e) {
        console.warn(`[${p.id}] failed:`, e);
        state.data[p.id] = { error: String(e.message || e) };
      }
    }));

    renderHero();
    renderTables();
  }

  // ---- rendering: hero --------------------------------------------------

  function renderHero() {
    if (!state.city) {
      $('#loc-name').innerHTML = '—';
      $('#loc-meta').textContent = 'выберите город, чтобы загрузить прогнозы';
      $('#hero-now').innerHTML = '';
      return;
    }

    const c = state.city;
    const place = `${c.name}${c.admin1 && c.admin1 !== c.name ? ', ' + c.admin1 : ''}`;
    $('#loc-name').innerHTML = `${escapeHtml(place)} <em>${escapeHtml(c.country_code || '')}</em>`;

    const providers = activeProviders();
    $('#loc-meta').textContent = `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)} · ${providers.length} источник${suffix(providers.length, ['', 'а', 'ов'])}`;

    // consensus current
    const currents = providers
      .map(p => state.data[p.id]?.current)
      .filter(Boolean);

    if (!currents.length) {
      $('#hero-now').innerHTML = '<span class="skeleton" style="width:140px;height:64px;display:block;border-radius:8px;"></span>';
      return;
    }

    const tempAvg = median(currents.map(c => c.temp));
    const feels = median(currents.map(c => c.feels_like));
    const wind = median(currents.map(c => c.wind_speed));
    const dir  = circularMean(currents.map(c => c.wind_direction).filter(v => v != null));
    const press = median(currents.map(c => c.pressure));

    $('#hero-now').innerHTML = `
      <div class="big">${fmtTemp(tempAvg).replace('°','')}<sup>°</sup></div>
      <div class="small-stack">
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

  const PARAMS = {
    temp:        { label: 'Температура',      unit: '°',     get: o => o.temp,           fmt: fmtTemp,     useMedian: true },
    feels_like:  { label: 'Ощущается как',    unit: '°',     get: o => o.feels_like,     fmt: fmtTemp,     useMedian: true },
    pressure:    { label: 'Давление',         unit: 'hPa',   get: o => o.pressure,       fmt: fmtPressure, useMedian: true },
    wind_speed:  { label: 'Скорость ветра',   unit: 'm/s',   get: o => o.wind_speed,     fmt: fmtWind,     useMedian: true },
    wind_dir:    { label: 'Направление',      unit: '°',     get: o => o.wind_direction, fmt: fmtDir,      circular: true },
    precipitation: { label: 'Осадки',         unit: 'мм',    get: o => o.precipitation,  fmt: fmtPrec,     useMedian: true },
  };

  const HOURLY_PARAMS = ['temp', 'feels_like', 'precipitation', 'wind_speed', 'pressure'];
  const DAILY_PARAMS  = ['temp_max_min', 'feels_like_max_min', 'precipitation_sum', 'wind_speed_max'];

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

  // ---- NOW table: rows = parameters, cols = providers + mean ------------

  function renderNowTable() {
    const providers = activeProviders().filter(p => state.data[p.id]?.current);
    const rows = ['temp', 'feels_like', 'pressure', 'wind_speed', 'wind_dir', 'precipitation'];

    if (!providers.length) {
      $('#table-now').innerHTML = `<tbody><tr><td class="empty" colspan="9">Нет доступных источников. Откройте настройки и проверьте, какие провайдеры включены.</td></tr></tbody>`;
      return;
    }

    const headers = providers.map(p =>
      `<th title="${escapeHtml(p.region)}">${escapeHtml(p.name)}</th>`
    ).join('');

    const body = rows.map(rk => {
      const param = PARAMS[rk];
      const cells = providers.map(p => {
        const v = param.get(state.data[p.id].current);
        return `<td>${param.fmt(v)}</td>`;
      });
      // mean
      let avg;
      if (param.circular) {
        const dirs = providers.map(p => state.data[p.id].current.wind_direction).filter(v => v != null);
        avg = dirs.length ? circularMean(dirs) : null;
      } else {
        avg = median(providers.map(p => param.get(state.data[p.id].current)));
      }
      cells.push(`<td class="mean">${param.fmt(avg)}</td>`);
      return `
        <tr>
          <td class="row-label">${param.label}<span class="unit">${param.unit}</span></td>
          ${cells.join('')}
        </tr>`;
    }).join('');

    $('#table-now').innerHTML = `
      <thead><tr><th></th>${headers}<th class="col-mean">Среднее</th></tr></thead>
      <tbody>${body}</tbody>
    `;
  }

  // ---- HOURLY tabs + table ----------------------------------------------

  function renderHourlyTabs() {
    $('#hourly-tabs').innerHTML = HOURLY_PARAMS.map(p => `
      <button data-param="${p}" class="${p === state.activeHourlyParam ? 'active' : ''}">${PARAMS[p].label}</button>
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

    const param = PARAMS[state.activeHourlyParam];

    // Берём timeline из первого провайдера (open-meteo дают одинаковые шаги).
    // Показываем 24 часа от ближайшего часа.
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

      const values = providers.map(p => {
        // ищем точку в этом провайдере по времени (ближайшее)
        const ph = state.data[p.id].hourly;
        const target = t.getTime();
        let best = null, bestDiff = Infinity;
        for (const pt of ph) {
          const d = Math.abs(new Date(pt.time).getTime() - target);
          if (d < bestDiff) { bestDiff = d; best = pt; }
          if (d > 60 * 60 * 1000) continue;
        }
        // допускаем расхождение до 90 минут
        if (best && bestDiff <= 90 * 60 * 1000) return param.get(best);
        return null;
      });

      const cells = values.map(v => `<td class="${isNow ? 'col-now' : ''}">${param.fmt(v)}</td>`);
      let avg;
      if (param.circular) {
        const dirs = values.filter(v => v != null);
        avg = dirs.length ? circularMean(dirs) : null;
      } else {
        avg = median(values);
      }
      cells.push(`<td class="mean ${isNow ? 'col-now' : ''}">${param.fmt(avg)}</td>`);

      return `<tr>${timeLabel}${cells.join('')}</tr>`;
    }).join('');

    $('#table-hourly').innerHTML = `
      <thead><tr><th>Время</th>${headers}<th class="col-mean">Среднее</th></tr></thead>
      <tbody>${body}</tbody>
    `;
  }

  function formatHour(d) {
    const today = new Date();
    const dayLabel = (d.getDate() === today.getDate() && d.getMonth() === today.getMonth())
      ? 'сегодня'
      : (d.getDate() === today.getDate() + 1 || (d.getDate() === 1 && today.getDate() > 27))
        ? 'завтра'
        : ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()];
    return `${dayLabel} ${String(d.getHours()).padStart(2, '0')}:00`;
  }

  // ---- DAILY tabs + table -----------------------------------------------

  function renderDailyTabs() {
    const tabs = [
      { id: 'temp_max_min',       label: 'Температура (мин/макс)' },
      { id: 'feels_like_max_min', label: 'Ощущается (мин/макс)' },
      { id: 'precipitation_sum',  label: 'Сумма осадков' },
      { id: 'wind_speed_max',     label: 'Макс. ветер' },
    ];
    $('#daily-tabs').innerHTML = tabs.map(t => `
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

    const body = days.map((day) => {
      const dt = new Date(day.date);
      const dayLabel = `<td class="row-label">${formatDay(dt)}</td>`;

      const values = providers.map(p => {
        const pd = state.data[p.id].daily.find(x => x.date === day.date);
        return pd || null;
      });

      let cells, avgCell;
      const k = state.activeDailyParam;

      if (k === 'temp_max_min') {
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
      } else { // wind_speed_max
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

  // ---- Map: Windy iframe (с разноцветными слоями rain/wind/temp) --------
  // Дополнительно — кнопка "Открыть Яндекс Nowcast" (надёжная ссылка).

  function renderMap() {
    const el = $('#map-wrap');
    if (!state.city) {
      el.innerHTML = `<div class="map-fallback">Выберите город, чтобы увидеть карту осадков.</div>`;
      return;
    }
    const { latitude, longitude } = state.city;
    const yandexUrl = `https://yandex.ru/pogoda/maps/nowcast?lat=${latitude}&lon=${longitude}&z=9`;
    // Windy embed: overlay=radar (рекомендуется для движения осадков)
    const windyUrl = `https://embed.windy.com/embed2.html?lat=${latitude}&lon=${longitude}&zoom=8&level=surface&overlay=radar&product=radar&menu=&message=true&marker=true&calendar=&pressure=&type=map&location=coordinates&detail=&metricWind=m%2Fs&metricTemp=%C2%B0C&radarRange=-1`;

    el.innerHTML = `
      <iframe src="${windyUrl}" loading="lazy" title="Windy radar"></iframe>
      <div style="position:absolute; bottom:10px; right:10px; display:flex; gap:8px;">
        <a class="map-fallback-link" href="${yandexUrl}" target="_blank" rel="noopener"
           style="padding:8px 14px;background:rgba(20,23,28,0.92);border:1px solid var(--line);border-radius:6px;color:var(--text);font-size:12px;text-decoration:none;backdrop-filter:blur(6px);">
          Открыть Яндекс Nowcast →
        </a>
      </div>
    `;
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
    // model toggles
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
    // первый запуск: пробуем взять координаты браузера
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          // обратное геокодирование через Open-Meteo
          const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=ru&format=json`;
          const r = await fetch(url);
          if (r.ok) {
            const j = await r.json();
            const top = (j.results && j.results[0]) || null;
            if (top) {
              pickCity(top);
              return;
            }
          }
          // fallback: создаём минимальную city из координат
          state.city = {
            name: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
            country: '',
            country_code: '',
            latitude, longitude,
          };
          saveState();
          loadAllAndRender();
        } catch (e) { /* user can search manually */ }
      }, () => { /* denied — user will search manually */ }, { timeout: 5000 });
    }
  }

})();
