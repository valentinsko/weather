/* ======================================================================
   providers.js
   Каждый провайдер возвращает унифицированную структуру:
   {
     current: { temp, feels_like, pressure, wind_speed, wind_direction, precipitation, humidity },
     hourly:  [{ time, temp, feels_like, pressure, wind_speed, wind_direction, precipitation }, ...],
     daily:   [{ date, temp_max, temp_min, feels_like_max, feels_like_min, precipitation_sum, wind_speed_max, wind_direction_dominant }, ...]
   }
   Все единицы — метрические внутри (°C, м/с, мм, hPa). Перевод в imperial — в UI-слое.
   ====================================================================== */

(function (global) {
  'use strict';

  // ---- helpers ----------------------------------------------------------

  async function safeJson(url, opts) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(tid);
    }
  }

  // Open-Meteo: зацикленные параметры одинаковы для всех моделей.
  // На каждую модель делаем отдельный запрос — это позволяет аккуратно
  // обработать ошибку одной модели не ломая остальные.
  function openMeteoFactory({ id, name, region, model }) {
    return {
      id,
      name,
      region,
      kind: 'open-meteo',
      requiresKey: false,
      enabledByDefault: true,
      async fetch(lat, lon) {
        const params = new URLSearchParams({
          latitude: lat,
          longitude: lon,
          current: 'temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation,weather_code',
          hourly: 'temperature_2m,apparent_temperature,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation',
          daily: 'temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant',
          timezone: 'auto',
          forecast_days: 7,
          wind_speed_unit: 'ms',
        });
        if (model) params.set('models', model);
        const url = `https://api.open-meteo.com/v1/forecast?${params}`;
        const j = await safeJson(url);

        const current = j.current ? {
          temp: j.current.temperature_2m,
          feels_like: j.current.apparent_temperature,
          pressure: j.current.pressure_msl,
          wind_speed: j.current.wind_speed_10m,
          wind_direction: j.current.wind_direction_10m,
          precipitation: j.current.precipitation,
          humidity: j.current.relative_humidity_2m,
          weather_code: j.current.weather_code,
        } : null;

        const hourly = (j.hourly && j.hourly.time) ? j.hourly.time.map((t, i) => ({
          time: t,
          temp: j.hourly.temperature_2m?.[i],
          feels_like: j.hourly.apparent_temperature?.[i],
          pressure: j.hourly.pressure_msl?.[i],
          wind_speed: j.hourly.wind_speed_10m?.[i],
          wind_direction: j.hourly.wind_direction_10m?.[i],
          precipitation: j.hourly.precipitation?.[i],
        })) : [];

        const daily = (j.daily && j.daily.time) ? j.daily.time.map((d, i) => ({
          date: d,
          temp_max: j.daily.temperature_2m_max?.[i],
          temp_min: j.daily.temperature_2m_min?.[i],
          feels_like_max: j.daily.apparent_temperature_max?.[i],
          feels_like_min: j.daily.apparent_temperature_min?.[i],
          precipitation_sum: j.daily.precipitation_sum?.[i],
          wind_speed_max: j.daily.wind_speed_10m_max?.[i],
          wind_direction_dominant: j.daily.wind_direction_10m_dominant?.[i],
        })) : [];

        return { current, hourly, daily };
      },
    };
  }

  // ---- OpenWeatherMap (One Call 3.0) ------------------------------------
  // Free tier выдаёт ключ по запросу с тарифом "One Call by Call".
  // Резервный вариант — старый /forecast (3-hour, 5 days) + /weather (current).

  const OWM = {
    id: 'owm',
    name: 'OpenWeatherMap',
    region: 'aggregator',
    kind: 'owm',
    requiresKey: true,
    keyHint: 'API key с openweathermap.org',
    enabledByDefault: false,
    async fetch(lat, lon, opts) {
      const key = opts && opts.apiKey;
      if (!key) throw new Error('Нет API-ключа');

      // current
      const curUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${key}`;
      // 5-day / 3-hour forecast
      const fcUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${key}`;

      const [cur, fc] = await Promise.all([safeJson(curUrl), safeJson(fcUrl)]);

      const current = {
        temp: cur.main?.temp,
        feels_like: cur.main?.feels_like,
        pressure: cur.main?.pressure,
        wind_speed: cur.wind?.speed,
        wind_direction: cur.wind?.deg,
        precipitation: (cur.rain?.['1h'] ?? 0) + (cur.snow?.['1h'] ?? 0),
        humidity: cur.main?.humidity,
      };

      const hourly = (fc.list || []).map(h => ({
        time: new Date(h.dt * 1000).toISOString(),
        temp: h.main?.temp,
        feels_like: h.main?.feels_like,
        pressure: h.main?.pressure,
        wind_speed: h.wind?.speed,
        wind_direction: h.wind?.deg,
        precipitation: (h.rain?.['3h'] ?? 0) + (h.snow?.['3h'] ?? 0),
      }));

      // daily — собираем агрегатами по дате из 3-часовых
      const byDate = new Map();
      hourly.forEach(h => {
        const d = h.time.slice(0, 10);
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(h);
      });
      const daily = [...byDate.entries()].slice(0, 7).map(([date, arr]) => {
        const temps = arr.map(x => x.temp).filter(v => v != null);
        const feels = arr.map(x => x.feels_like).filter(v => v != null);
        const winds = arr.map(x => x.wind_speed).filter(v => v != null);
        const precSum = arr.reduce((s, x) => s + (x.precipitation || 0), 0);
        const dirs = arr.map(x => x.wind_direction).filter(v => v != null);
        return {
          date,
          temp_max: temps.length ? Math.max(...temps) : null,
          temp_min: temps.length ? Math.min(...temps) : null,
          feels_like_max: feels.length ? Math.max(...feels) : null,
          feels_like_min: feels.length ? Math.min(...feels) : null,
          precipitation_sum: precSum,
          wind_speed_max: winds.length ? Math.max(...winds) : null,
          wind_direction_dominant: dirs.length ? circularMean(dirs) : null,
        };
      });

      return { current, hourly, daily };
    },
  };

  // ---- WeatherAPI.com ---------------------------------------------------

  const WAPI = {
    id: 'wapi',
    name: 'WeatherAPI',
    region: 'aggregator',
    kind: 'wapi',
    requiresKey: true,
    keyHint: 'API key с weatherapi.com',
    enabledByDefault: false,
    async fetch(lat, lon, opts) {
      const key = opts && opts.apiKey;
      if (!key) throw new Error('Нет API-ключа');

      const url = `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=${lat},${lon}&days=7&aqi=no&alerts=no`;
      const j = await safeJson(url);

      const c = j.current || {};
      const current = {
        temp: c.temp_c,
        feels_like: c.feelslike_c,
        pressure: c.pressure_mb,
        wind_speed: c.wind_kph != null ? c.wind_kph / 3.6 : null,
        wind_direction: c.wind_degree,
        precipitation: c.precip_mm,
        humidity: c.humidity,
      };

      const hourly = [];
      (j.forecast?.forecastday || []).forEach(d => {
        (d.hour || []).forEach(h => {
          hourly.push({
            time: new Date(h.time_epoch * 1000).toISOString(),
            temp: h.temp_c,
            feels_like: h.feelslike_c,
            pressure: h.pressure_mb,
            wind_speed: h.wind_kph != null ? h.wind_kph / 3.6 : null,
            wind_direction: h.wind_degree,
            precipitation: h.precip_mm,
          });
        });
      });

      const daily = (j.forecast?.forecastday || []).map(d => ({
        date: d.date,
        temp_max: d.day?.maxtemp_c,
        temp_min: d.day?.mintemp_c,
        feels_like_max: null,
        feels_like_min: null,
        precipitation_sum: d.day?.totalprecip_mm,
        wind_speed_max: d.day?.maxwind_kph != null ? d.day.maxwind_kph / 3.6 : null,
        wind_direction_dominant: null,
      }));

      return { current, hourly, daily };
    },
  };

  // ---- circular mean for wind direction ---------------------------------

  function circularMean(degs) {
    let sx = 0, sy = 0;
    for (const d of degs) {
      const r = (d * Math.PI) / 180;
      sx += Math.cos(r);
      sy += Math.sin(r);
    }
    let a = (Math.atan2(sy, sx) * 180) / Math.PI;
    if (a < 0) a += 360;
    return a;
  }

  // ---- registry ---------------------------------------------------------

  const PROVIDERS = [
    openMeteoFactory({ id: 'om_ecmwf',     name: 'ECMWF IFS',      region: 'EU · ECMWF',         model: 'ecmwf_ifs04' }),
    openMeteoFactory({ id: 'om_icon',      name: 'ICON',           region: 'DE · DWD',           model: 'icon_seamless' }),
    openMeteoFactory({ id: 'om_gfs',       name: 'GFS',            region: 'US · NOAA',          model: 'gfs_seamless' }),
    openMeteoFactory({ id: 'om_arpege',    name: 'ARPEGE',         region: 'FR · Météo-France',  model: 'meteofrance_seamless' }),
    openMeteoFactory({ id: 'om_gem',       name: 'GEM',            region: 'CA · ECCC',          model: 'gem_seamless' }),
    openMeteoFactory({ id: 'om_jma',       name: 'JMA',            region: 'JP · 気象庁',         model: 'jma_seamless' }),
    openMeteoFactory({ id: 'om_best',      name: 'Open-Meteo',     region: 'best-match · OM',    model: '' }),
    OWM,
    WAPI,
  ];

  global.METEUM_PROVIDERS = PROVIDERS;
  global.METEUM_UTIL = { circularMean };

})(window);
