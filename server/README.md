# SRCTools 24/7 Webhook Worker

Серверный сервис для Railway, от Tauri-приложения не зависит.

Опрашивает Speedrun.com и шлёт в Discord события по ранам Run pro (`o1yj25r1`) и
Bhop pro (`268q8o6p`): новый ран, verified, rejected. Ссылка, карта, игрок и время
берутся из ответа API. Первый опрос каждого feed — baseline, старые записи в Discord
не уходят. Baseline, дедуп и очередь Discord хранятся в SQLite.

## Переменные окружения

Обязательные:

| Variable | Значение |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | URL из Discord: Channel Settings → Integrations → Webhooks |
| `SPEEDRUN_API_KEY` | Ключ аккаунта-модератора: <https://www.speedrun.com/settings/api> |

Необязательные:

| Variable | Default | Значение |
| --- | --- | --- |
| `MONITORED_EVENTS` | `new,verified,rejected` | Комбинация этих значений через запятую |
| `MONITORED_GAME_IDS` | `o1yj25r1,268q8o6p` | Можно сузить до одной игры; другие ID запрещены |
| `PORT` | `3000` | Railway задаёт сам, вручную не добавлять |
| `RAILWAY_VOLUME_MOUNT_PATH` | `./data` | Railway задаёт сам после подключения Volume |

Интервал опроса — 8 секунд, зашит в коде.

## Локальный запуск

Нужен Node.js 22.13+ (ветка 22.x).

```powershell
cd server
npm install
Copy-Item .env.example .env   # заполнить два секрета
npm test
npm run build
node --env-file=.env dist/index.js
```

Проверка: `Invoke-RestMethod http://localhost:3000/health`.

После baseline в логах:

```text
[Worker] Checking Speedrun.com...
[Worker] Found 0 new event(s)
[Worker] Next check in 6s
```

## Деплой на Railway

1. Project → Deploy from GitHub repo → `Awernox/SRCTools`.
2. Service Settings → **Root Directory**: `/server`.
3. Build: `npm run build`. Start: `node dist/index.js` (Railpack подхватит сам).
4. Variables: `DISCORD_WEBHOOK_URL`, `SPEEDRUN_API_KEY`. `PORT` не добавлять.
5. Volumes → Add Volume, Mount Path `/app/data` — туда ляжет `srctools-worker.sqlite`.
6. Одна replica: один Volume нельзя монтировать в несколько процессов.
7. Deploy settings: Healthcheck Path `/health`, Restart Policy `Always`, Draining ≥ 30 сек.
8. Отключить App Sleeping — сервис должен работать постоянно.

`/health` отвечает 200 сразу (liveness), `/ready` — 503 до первого успешного опроса.
Healthcheck держать на `/health`.

## Заметки

- Дедуп по ключу `(account, тип события, run id)`. Один ран может дать два сообщения
  (сначала New Run, потом verified/rejected), но одно событие дважды не уйдёт. У Discord
  нет idempotency key, поэтому семантика at-least-once: если процесс упал сразу после
  доставки, после рестарта возможен один повтор.
- Сбой Discord worker не роняет: до трёх retry на запрос, дальше outbox переносит попытку
  на следующий цикл. Битый или удалённый webhook останавливает событие сразу.
- Volume при redeploy не удалять — в нём состояние дедупа. Без Volume после каждого
  redeploy будет новый baseline: спама не будет, но события за время простоя могут пропасть.
- Каждый feed читает только верхние 20 строк. Крупный всплеск между опросами может
  вытеснить нужный ран. У rejected нет `verify-date`, поэтому feed сортируется по времени сабмита.
