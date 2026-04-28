# Meteum — consensus weather

Тёмный single-page агрегатор прогнозов погоды. Сравнивает прогнозы от **6+ независимых метеомоделей одновременно** (ECMWF, ICON-DWD, GFS-NOAA, Météo-France ARPEGE, Canada GEM, Japan JMA) и считает по ним **медиану**. Опционально — OpenWeatherMap и WeatherAPI по своим ключам.

Работает целиком в браузере. Деплой — статика на GitHub Pages.

## Что внутри

- 🌡️ **Текущая погода** — таблица параметров (температура, ощущается, давление, ветер, направление, осадки) × источников + столбец «Среднее»
- 🕐 **Почасовой прогноз на 24 часа** — переключение между параметрами, медиана по моделям
- 📅 **Прогноз на 7 дней** — мин/макс температуры, осадки, ветер
- 🗺️ **Карта движения осадков** — встроенный Windy radar + ссылка на Яндекс.Погода Nowcast
- 🔍 **Поиск города** с автокомплитом и геолокацией браузера
- 💾 **Память города и настроек** — localStorage, ничего на сервер не уходит
- ⚙️ **Панель настроек** — включение/выключение моделей, ввод API-ключей, выбор единиц (метрические / имперские)

## Quick start

```bash
git clone https://github.com/<your-username>/<repo>.git
cd <repo>
# открыть index.html в браузере, или поднять любой статический сервер:
python3 -m http.server 8080
```

Затем `http://localhost:8080`.

## Деплой на GitHub Pages

1. Закоммить файлы в `main`.
2. В настройках репозитория: **Settings → Pages → Source: Deploy from branch → main / root**.
3. Через минуту приложение откроется на `https://<username>.github.io/<repo>/`.

Файл `.nojekyll` в корне — чтобы Pages не пытался обрабатывать как Jekyll-сайт.

## Источники

### Без ключей (работают сразу)

Все шесть метеомоделей берутся через [Open-Meteo](https://open-meteo.com), который бесплатно предоставляет доступ к моделям национальных метеослужб без регистрации:

| Источник | Регион | Параметр модели |
|---|---|---|
| ECMWF IFS | Европа | `ecmwf_ifs04` |
| ICON | Германия (DWD) | `icon_seamless` |
| GFS | США (NOAA) | `gfs_seamless` |
| ARPEGE | Франция (Météo-France) | `meteofrance_seamless` |
| GEM | Канада (ECCC) | `gem_seamless` |
| JMA | Япония | `jma_seamless` |
| best-match | Open-Meteo (auto) | (по умолчанию) |

### С ключами (опционально)

| Сервис | Бесплатный лимит | Где получить |
|---|---|---|
| OpenWeatherMap | 1M вызовов/мес | https://openweathermap.org/api |
| WeatherAPI | 1M вызовов/мес | https://www.weatherapi.com/ |

Ключи сохраняются в localStorage браузера. На сервер не отправляются.

### Премиум-источники (требуют backend)

Эти три API популярны, но **не работают напрямую из браузера** — нужен прокси:

- **Google Weather API** (Google Maps Platform). API-ключ нельзя выставлять в публичном фронте, плюс платформа требует биллинг-аккаунт. До 10k вызовов/мес бесплатно.
- **Яндекс.Погода API**. Требует регистрации в Yandex Cloud и часто бизнес-аккаунта. CORS закрыт.
- **Apple WeatherKit**. Требует Apple Developer Program ($99/год) и подписания JWT приватным ключом — в браузере приватный ключ держать нельзя.

Чтобы добавить любой из них, разверните **serverless-прокси** (Cloudflare Workers / Vercel Functions / Netlify Functions / Deno Deploy — все имеют бесплатные тарифы) и добавьте провайдер в `providers.js`. Шаблон в комментариях файла.

Пример Cloudflare Worker для Google Weather:

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');
    const r = await fetch(
      `https://weather.googleapis.com/v1/currentConditions:lookup?key=${env.GOOGLE_KEY}&location.latitude=${lat}&location.longitude=${lon}`
    );
    return new Response(await r.text(), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  },
};
```

Затем в `providers.js` добавьте:

```js
const GOOGLE = {
  id: 'google',
  name: 'Google Weather',
  region: 'US · Google MetNet',
  kind: 'google',
  requiresKey: false,
  enabledByDefault: true,
  async fetch(lat, lon) {
    const r = await fetch(`https://your-worker.workers.dev/?lat=${lat}&lon=${lon}`);
    const j = await r.json();
    return { current: { ... }, hourly: [...], daily: [...] };
  },
};
PROVIDERS.push(GOOGLE);
```

## Архитектура

```
index.html       разметка
styles.css       тёмная editorial-тема (Fraunces / Albert Sans / JetBrains Mono)
providers.js     адаптеры источников → единая структура { current, hourly, daily }
app.js           геокодинг, оркестрация запросов, медиана, рендер таблиц, настройки
```

Каждый провайдер возвращает одну и ту же форму:

```js
{
  current: { temp, feels_like, pressure, wind_speed, wind_direction, precipitation, humidity },
  hourly:  [{ time, temp, feels_like, pressure, wind_speed, wind_direction, precipitation }, ...],
  daily:   [{ date, temp_max, temp_min, feels_like_max, feels_like_min, precipitation_sum, wind_speed_max, wind_direction_dominant }, ...]
}
```

Все единицы внутри — метрические (°C, м/с, мм, hPa). Конверсия в imperial — в UI-слое.

Для усреднения используется **медиана** (а не арифметическое среднее) — она устойчива к выбросам отдельных моделей. Для направления ветра — циркулярное среднее (через атан2 от усреднённых компонент).

## Лицензия

MIT. Делайте что хотите.

## Атрибуция

- Метеомодели предоставлены через [Open-Meteo](https://open-meteo.com) — open source weather API
- Карта осадков — [Windy.com](https://www.windy.com)
- Ссылка на nowcast — [Яндекс.Погода](https://yandex.ru/pogoda/maps/nowcast)
