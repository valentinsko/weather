/* ======================================================================
   providers.js
   Каждый провайдер возвращает унифицированную структуру:
   {
     current: { temp, feels_like, pressure, wind_speed, wind_direction,
                precipitation, humidity, weather_kind, severity, is_day },
     hourly:  [{ time, temp, feels_like, pressure, wind_speed, wind_direction,
                 precipitation, weather_kind, severity, is_day }, ...],
     daily:   [{ date, temp_max, temp_min, feels_like_max, feels_like_min,
                 precipitation_sum, wind_speed_max, wind_direction_dominant,
                 weather_kind, severity }, ...]
   }
   Внутренние единицы: °C, м/с, мм, hPa. Конверсия в UI-слое.

   weather_kind ∈ {
     'clear', 'mostly_clear', 'partly_cloudy', 'cloudy',
     'fog',
     'drizzle', 'freezing_drizzle',
     'rain', 'rain_showers', 'freezing_rain',
     'snow', 'snow_showers', 'sleet',
     'hail',
     'thunderstorm', 'thunderstorm_hail',
     'unknown'
   }
   severity ∈ { 'light', 'moderate', 'heavy', null }
   ====================================================================== */

(function (global) {
  'use strict';

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

  // ---- WMO weather codes (Open-Meteo) ----------------------------------

  function wmoToKind(code) {
    if (code == null) return { kind: 'unknown', severity: null };
    switch (code) {
      case 0:  return { kind: 'clear',         severity: null };
      case 1:  return { kind: 'mostly_clear',  severity: null };
      case 2:  return { kind: 'partly_cloudy', severity: null };
      case 3:  return { kind: 'cloudy',        severity: null };
      case 45:
      case 48: return { kind: 'fog',           severity: null };
      case 51: return { kind: 'drizzle',       severity: 'light' };
      case 53: return { kind: 'drizzle',       severity: 'moderate' };
      case 55: return { kind: 'drizzle',       severity: 'heavy' };
      case 56: return { kind: 'freezing_drizzle', severity: 'light' };
      case 57: return { kind: 'freezing_drizzle', severity: 'heavy' };
      case 61: return { kind: 'rain',          severity: 'light' };
      case 63: return { kind: 'rain',          severity: 'moderate' };
      case 65: return { kind: 'rain',          severity: 'heavy' };
      case 66: return { kind: 'freezing_rain', severity: 'light' };
      case 67: return { kind: 'freezing_rain', severity: 'heavy' };
      case 71: return { kind: 'snow',          severity: 'light' };
      case 73: return { kind: 'snow',          severity: 'moderate' };
      case 75: return { kind: 'snow',          severity: 'heavy' };
      case 77: return { kind: 'snow',          severity: 'light' }; // grains
      case 80: return { kind: 'rain_showers',  severity: 'light' };
      case 81: return { kind: 'rain_showers',  severity: 'moderate' };
      case 82: return { kind: 'rain_showers',  severity: 'heavy' };
      case 85: return { kind: 'snow_showers',  severity: 'light' };
      case 86: return { kind: 'snow_showers',  severity: 'heavy' };
      case 95: return { kind: 'thunderstorm',  severity: 'moderate' };
      case 96: return { kind: 'thunderstorm_hail', severity: 'light' };
      case 99: return { kind: 'thunderstorm_hail', severity: 'heavy' };
      default: return { kind: 'unknown', severity: null };
    }
  }

  // ---- OpenWeatherMap "id" codes ---------------------------------------

  function owmToKind(id) {
    if (id == null) return { kind: 'unknown', severity: null };
    if (id >= 200 && id <= 232) {
      return { kind: 'thunderstorm', severity: id >= 211 && id <= 232 ? 'heavy' : 'moderate' };
    }
    if (id >= 300 && id <= 321) {
      const s = id <= 301 ? 'light' : id <= 311 ? 'moderate' : 'heavy';
      return { kind: 'drizzle', severity: s };
    }
    if (id >= 500 && id <= 504) {
      const s = id === 500 ? 'light' : id === 501 ? 'moderate' : 'heavy';
      return { kind: 'rain', severity: s };
    }
    if (id === 511) return { kind: 'freezing_rain', severity: 'light' };
    if (id >= 520 && id <= 531) {
      const s = id === 520 ? 'light' : id === 521 ? 'moderate' : 'heavy';
      return { kind: 'rain_showers', severity: s };
    }
    if (id >= 600 && id <= 622) {
      if (id === 611 || id === 612 || id === 613) return { kind: 'sleet', severity: 'light' };
      if (id === 615 || id === 616) return { kind: 'sleet', severity: 'moderate' };
      const s = id === 600 ? 'light' : id === 601 ? 'moderate' : 'heavy';
      return { kind: 'snow', severity: s };
    }
    if (id >= 700 && id < 800) return { kind: 'fog', severity: null };
    if (id === 800) return { kind: 'clear', severity: null };
    if (id === 801) return { kind: 'mostly_clear', severity: null };
    if (id === 802) return { kind: 'partly_cloudy', severity: null };
    if (id === 803 || id === 804) return { kind: 'cloudy', severity: null };
    return { kind: 'unknown', severity: null };
  }

  // ---- WeatherAPI.com codes --------------------------------------------

  function wapiToKind(code) {
    if (code == null) return { kind: 'unknown', severity: null };
    const m = {
      1000: ['clear', null],
      1003: ['partly_cloudy', null],
      1006: ['cloudy', null],
      1009: ['cloudy', null],
      1030: ['fog', null],
      1063: ['rain', 'light'],
      1066: ['snow', 'light'],
      1069: ['sleet', 'light'],
      1072: ['freezing_drizzle', 'light'],
      1087: ['thunderstorm', 'moderate'],
      1114: ['snow', 'heavy'],
      1117: ['snow', 'heavy'],
      1135: ['fog', null],
      1147: ['fog', null],
      1150: ['drizzle', 'light'],
      1153: ['drizzle', 'light'],
      1168: ['freezing_drizzle', 'light'],
      1171: ['freezing_drizzle', 'heavy'],
      1180: ['rain', 'light'],
      1183: ['rain', 'light'],
      1186: ['rain', 'moderate'],
      1189: ['rain', 'moderate'],
      1192: ['rain', 'heavy'],
      1195: ['rain', 'heavy'],
      1198: ['freezing_rain', 'light'],
      1201: ['freezing_rain', 'heavy'],
      1204: ['sleet', 'light'],
      1207: ['sleet', 'heavy'],
      1210: ['snow', 'light'],
      1213: ['snow', 'light'],
      1216: ['snow', 'moderate'],
      1219: ['snow', 'moderate'],
      1222: ['snow', 'heavy'],
      1225: ['snow', 'heavy'],
      1237: ['hail', 'light'],
      1240: ['rain_showers', 'light'],
      1243: ['rain_showers', 'moderate'],
      1246: ['rain_showers', 'heavy'],
      1249: ['sleet', 'light'],
      1252: ['sleet', 'heavy'],
      1255: ['snow_showers', 'light'],
      1258: ['snow_showers', 'heavy'],
      1261: ['hail', 'light'],
      1264: ['hail', 'heavy'],
      1273: ['thunderstorm', 'light'],
      1276: ['thunderstorm', 'heavy'],
      1279: ['thunderstorm', 'light'],
      1282: ['thunderstorm', 'heavy'],
    }[code];
    return m ? { kind: m[0], severity: m[1] } : { kind: 'unknown', severity: null };
  }

  // ---- severity rank (для определения "доминирующего" явления дня) ----

  function severityRank(o) {
    const sev = { heavy: 4, moderate: 3, light: 2 }[o?.severity] || 1;
    const w = {
      thunderstorm_hail: 100, hail: 90, thunderstorm: 80,
      freezing_rain: 70, freezing_drizzle: 60, sleet: 60,
      snow: 50, snow_showers: 50,
      rain: 40, rain_showers: 40, drizzle: 30,
      fog: 20,
      cloudy: 10, partly_cloudy: 5, mostly_clear: 3, clear: 1,
      unknown: 0,
    }[o?.weather_kind] || 0;
    return w * 10 + sev;
  }

  function circularMean(degs) {
    let sx = 0, sy = 0;
    for (const d of degs) {
      const r = (d * Math.PI) / 180;
      sx += Math.cos(r); sy += Math.sin(r);
    }
    let a = (Math.atan2(sy, sx) * 180) / Math.PI;
    if (a < 0) a += 360;
    return a;
  }

  // ---- Open-Meteo factory ----------------------------------------------

  function openMeteoFactory({ id, name, region, model }) {
    return {
      id, name, region,
      kind: 'open-meteo',
      requiresKey: false,
      enabledByDefault: true,
      async fetch(lat, lon) {
        const params = new URLSearchParams({
          latitude: lat,
          longitude: lon,
          current: 'temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation,weather_code,is_day',
          hourly:  'temperature_2m,apparent_temperature,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation,weather_code,is_day',
          daily:   'temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,weather_code',
          timezone: 'auto',
          forecast_days: 7,
          wind_speed_unit: 'ms',
        });
        if (model) params.set('models', model);
        const url = `https://api.open-meteo.com/v1/forecast?${params}`;
        const j = await safeJson(url);

        const c = j.current || {};
        const cw = wmoToKind(c.weather_code);
        const current = j.current ? {
          temp: c.temperature_2m,
          feels_like: c.apparent_temperature,
          pressure: c.pressure_msl,
          wind_speed: c.wind_speed_10m,
          wind_direction: c.wind_direction_10m,
          precipitation: c.precipitation,
          humidity: c.relative_humidity_2m,
          weather_kind: cw.kind,
          severity: cw.severity,
          is_day: c.is_day === 1,
        } : null;

        const hourly = (j.hourly && j.hourly.time) ? j.hourly.time.map((t, i) => {
          const w = wmoToKind(j.hourly.weather_code?.[i]);
          return {
            time: t,
            temp: j.hourly.temperature_2m?.[i],
            feels_like: j.hourly.apparent_temperature?.[i],
            pressure: j.hourly.pressure_msl?.[i],
            wind_speed: j.hourly.wind_speed_10m?.[i],
            wind_direction: j.hourly.wind_direction_10m?.[i],
            precipitation: j.hourly.precipitation?.[i],
            weather_kind: w.kind,
            severity: w.severity,
            is_day: j.hourly.is_day?.[i] === 1,
          };
        }) : [];

        const daily = (j.daily && j.daily.time) ? j.daily.time.map((d, i) => {
          const w = wmoToKind(j.daily.weather_code?.[i]);
          return {
            date: d,
            temp_max: j.daily.temperature_2m_max?.[i],
            temp_min: j.daily.temperature_2m_min?.[i],
            feels_like_max: j.daily.apparent_temperature_max?.[i],
            feels_like_min: j.daily.apparent_temperature_min?.[i],
            precipitation_sum: j.daily.precipitation_sum?.[i],
            wind_speed_max: j.daily.wind_speed_10m_max?.[i],
            wind_direction_dominant: j.daily.wind_direction_10m_dominant?.[i],
            weather_kind: w.kind,
            severity: w.severity,
          };
        }) : [];

        return { current, hourly, daily };
      },
    };
  }

  // ---- OpenWeatherMap --------------------------------------------------

  const OWM = {
    id: 'owm', name: 'OpenWeatherMap', region: 'aggregator',
    kind: 'owm', requiresKey: true, enabledByDefault: false,
    keyHint: 'API key с openweathermap.org',
    async fetch(lat, lon, opts) {
      const key = opts && opts.apiKey;
      if (!key) throw new Error('Нет API-ключа');

      const curUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${key}`;
      const fcUrl  = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${key}`;
      const [cur, fc] = await Promise.all([safeJson(curUrl), safeJson(fcUrl)]);

      const wnow = owmToKind(cur.weather?.[0]?.id);
      const isDayNow = (cur.sys && cur.dt)
        ? (cur.dt >= cur.sys.sunrise && cur.dt < cur.sys.sunset)
        : null;

      const current = {
        temp: cur.main?.temp,
        feels_like: cur.main?.feels_like,
        pressure: cur.main?.pressure,
        wind_speed: cur.wind?.speed,
        wind_direction: cur.wind?.deg,
        precipitation: (cur.rain?.['1h'] ?? 0) + (cur.snow?.['1h'] ?? 0),
        humidity: cur.main?.humidity,
        weather_kind: wnow.kind,
        severity: wnow.severity,
        is_day: isDayNow,
      };

      const hourly = (fc.list || []).map(h => {
        const w = owmToKind(h.weather?.[0]?.id);
        return {
          time: new Date(h.dt * 1000).toISOString(),
          temp: h.main?.temp,
          feels_like: h.main?.feels_like,
          pressure: h.main?.pressure,
          wind_speed: h.wind?.speed,
          wind_direction: h.wind?.deg,
          precipitation: (h.rain?.['3h'] ?? 0) + (h.snow?.['3h'] ?? 0),
          weather_kind: w.kind,
          severity: w.severity,
          is_day: h.sys?.pod === 'd',
        };
      });

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
        const dom = [...arr].sort((a, b) => severityRank(b) - severityRank(a))[0] || {};

        return {
          date,
          temp_max: temps.length ? Math.max(...temps) : null,
          temp_min: temps.length ? Math.min(...temps) : null,
          feels_like_max: feels.length ? Math.max(...feels) : null,
          feels_like_min: feels.length ? Math.min(...feels) : null,
          precipitation_sum: precSum,
          wind_speed_max: winds.length ? Math.max(...winds) : null,
          wind_direction_dominant: dirs.length ? circularMean(dirs) : null,
          weather_kind: dom.weather_kind || 'unknown',
          severity: dom.severity || null,
        };
      });

      return { current, hourly, daily };
    },
  };

  // ---- WeatherAPI.com --------------------------------------------------

  const WAPI = {
    id: 'wapi', name: 'WeatherAPI', region: 'aggregator',
    kind: 'wapi', requiresKey: true, enabledByDefault: false,
    keyHint: 'API key с weatherapi.com',
    async fetch(lat, lon, opts) {
      const key = opts && opts.apiKey;
      if (!key) throw new Error('Нет API-ключа');

      const url = `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=${lat},${lon}&days=7&aqi=no&alerts=no`;
      const j = await safeJson(url);

      const c = j.current || {};
      const wnow = wapiToKind(c.condition?.code);
      const current = {
        temp: c.temp_c,
        feels_like: c.feelslike_c,
        pressure: c.pressure_mb,
        wind_speed: c.wind_kph != null ? c.wind_kph / 3.6 : null,
        wind_direction: c.wind_degree,
        precipitation: c.precip_mm,
        humidity: c.humidity,
        weather_kind: wnow.kind,
        severity: wnow.severity,
        is_day: c.is_day === 1,
      };

      const hourly = [];
      (j.forecast?.forecastday || []).forEach(d => {
        (d.hour || []).forEach(h => {
          const w = wapiToKind(h.condition?.code);
          hourly.push({
            time: new Date(h.time_epoch * 1000).toISOString(),
            temp: h.temp_c,
            feels_like: h.feelslike_c,
            pressure: h.pressure_mb,
            wind_speed: h.wind_kph != null ? h.wind_kph / 3.6 : null,
            wind_direction: h.wind_degree,
            precipitation: h.precip_mm,
            weather_kind: w.kind,
            severity: w.severity,
            is_day: h.is_day === 1,
          });
        });
      });

      const daily = (j.forecast?.forecastday || []).map(d => {
        const w = wapiToKind(d.day?.condition?.code);
        return {
          date: d.date,
          temp_max: d.day?.maxtemp_c,
          temp_min: d.day?.mintemp_c,
          feels_like_max: null,
          feels_like_min: null,
          precipitation_sum: d.day?.totalprecip_mm,
          wind_speed_max: d.day?.maxwind_kph != null ? d.day.maxwind_kph / 3.6 : null,
          wind_direction_dominant: null,
          weather_kind: w.kind,
          severity: w.severity,
        };
      });

      return { current, hourly, daily };
    },
  };

  // ---- registry ---------------------------------------------------------

  const PROVIDERS = [
    openMeteoFactory({ id: 'om_ecmwf',  name: 'ECMWF IFS', region: 'EU · ECMWF',        model: 'ecmwf_ifs025' }),
    openMeteoFactory({ id: 'om_icon',   name: 'ICON',      region: 'DE · DWD',          model: 'icon_seamless' }),
    openMeteoFactory({ id: 'om_gfs',    name: 'GFS',       region: 'US · NOAA',         model: 'gfs_seamless' }),
    openMeteoFactory({ id: 'om_arpege', name: 'ARPEGE',    region: 'FR · Météo-France', model: 'meteofrance_seamless' }),
    openMeteoFactory({ id: 'om_gem',    name: 'GEM',       region: 'CA · ECCC',         model: 'gem_seamless' }),
    openMeteoFactory({ id: 'om_jma',    name: 'JMA',       region: 'JP · 気象庁',         model: 'jma_seamless' }),
    openMeteoFactory({ id: 'om_best',   name: 'Open-Meteo', region: 'best-match',        model: '' }),
    OWM,
    WAPI,
  ];

  global.METEUM_PROVIDERS = PROVIDERS;
  global.METEUM_UTIL = { circularMean, severityRank };

})(window);
