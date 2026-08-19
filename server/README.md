# SRCTools 24/7 Webhook Worker

Отдельный серверный сервис для Railway. Он не импортирует и не меняет Tauri-приложение.

Worker повторяет существующую watcher-логику SRCTools:

- получает владельца API-ключа через `GET /profile`;
- получает модерируемые игры через `GET /games?moderator=...`;
- опрашивает глобальные feed `status=new`, `status=verified`, `status=rejected`;
- фильтрует их строго по Speedrun.com game ID: Run pro (`o1yj25r1`) и Bhop pro (`268q8o6p`);
- берёт ссылку run только из поля Speedrun.com `weblink`;
- берёт карту из embedded `level`, игрока из embedded `players`, время из `times.primary_t`;
- первую страницу каждого feed сохраняет как baseline и не отправляет старые события;
- хранит baseline, deduplication и очередь Discord в SQLite.

## Environment Variables

Обязательные:

| Variable | Значение |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | URL из Discord Channel Settings -> Integrations -> Webhooks |
| `SPEEDRUN_API_KEY` | Ключ аккаунта-модератора из <https://www.speedrun.com/settings/api> |

Необязательные:

| Variable | Default | Значение |
| --- | --- | --- |
| `MONITORED_EVENTS` | `new,verified,rejected` | Любая комбинация этих трёх значений через запятую |
| `MONITORED_GAME_IDS` | `o1yj25r1,268q8o6p` | Можно сузить scope до одной из этих игр. Другие game ID запрещены |
| `PORT` | `3000` | Railway задаёт автоматически, вручную там не добавлять |
| `RAILWAY_VOLUME_MOUNT_PATH` | `./data` | Railway задаёт автоматически после подключения Volume |

## Локальная проверка

Нужен Node.js 22.13 или новее из ветки 22.x.

```powershell
cd server
npm install
Copy-Item .env.example .env
# Заполнить два секрета в server/.env
npm test
npm run build
node --env-file=.env dist/index.js
```

Проверка health endpoint:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Первый poll создаёт baseline, поэтому существующие 20 записей не уйдут в Discord. После него в логах раз в `CHECK_INTERVAL_SECONDS` появляются:

```text
[Worker] Checking Speedrun.com...
[Worker] Found 0 new event(s)
[Worker] Next check in 2s
```

## Railway Deployment

1. Отправить директорию `server/` в тот же GitHub repository.
2. В Railway создать новый Project -> Deploy from GitHub repo.
3. Выбрать `Awernox/SRCTools` и нужную ветку.
4. В Service Settings установить **Root Directory**: `/server`.
5. Railway определит Node по `server/package.json`. Build command: `npm run build`; Start command: `node dist/index.js`. Обычно Railpack возьмёт их автоматически, но значения можно задать явно.
6. В Variables добавить `DISCORD_WEBHOOK_URL`, `SPEEDRUN_API_KEY`, `MONITORED_EVENTS=new,verified,rejected`, `MONITORED_GAME_IDS=o1yj25r1,268q8o6p`. `CHECK_INTERVAL_SECONDS` больше не используется, его можно удалить. Интервал опроса зафиксирован на 2 секунды. `PORT` не добавлять.
7. В сервисе открыть Volumes -> Add Volume. Mount Path: `/app/data`. Worker автоматически увидит `RAILWAY_VOLUME_MOUNT_PATH` и положит туда `srctools-worker.sqlite`.
8. Оставить **одну replica**. SQLite Volume нельзя безопасно использовать несколькими worker-процессами, и несколько replicas создали бы несколько polling loops.
9. В Deploy settings задать Healthcheck Path `/health`, Restart Policy `Always` и Draining/Shutdown period не меньше 30 секунд. `Always` доступен на платных планах.
10. Отключить Serverless/App Sleeping: worker должен оставаться persistent service.
11. Нажать Deploy. В deployment logs должны появиться `[Health] Listening`, `[Worker] Started`, `Scope refreshed` и циклы проверки.
12. При необходимости создать Public Domain и проверить `https://<domain>/health`. `/health` является liveness endpoint и возвращает HTTP 200 сразу после запуска HTTP-сервера, даже пока первый poll ещё выполняется. `/ready` является отдельным readiness endpoint и возвращает 503 до первой успешной проверки или если worker стал stale. Railway Healthcheck Path нужно оставить `/health`, не `/ready`.

## Как проверить работу 24/7

1. В Railway открыть Service -> Deployments -> активный deployment -> View Logs.
2. Убедиться, что строки `Checking Speedrun.com` и `Next check in 2s` продолжают появляться. При обновлении scope лог отдельно перечисляет `Run pro (o1yj25r1)` и `Bhop pro (268q8o6p)`.
3. `/health` показывает `status` (`starting`, `ok` или `degraded`), `lastCheckAt`, `lastSuccessAt`, `consecutiveFailures`, `scopedGames`, `pendingWebhooks`, `failedWebhooks` и последнюю ошибку Discord. HTTP 200 означает, что процесс жив; поле `status` и данные worker показывают состояние polling.
4. После baseline добавить тестовый настоящий run в модерируемую игру либо дождаться нового run. В логах появится `Found 1 new event(s)` и `[Discord] Webhook sent`.
5. Не удалять Volume при redeploy: именно там находится состояние deduplication.

## Как ограничивается дублирование webhook

SQLite хранит отдельно три feed и ключ события `(account, event kind, run id)`. Один run может законно дать два разных сообщения: сначала `New Run`, затем `Run verified` или `Run rejected`, но одно и то же событие второй раз не добавится. Feed state и outbox записываются одной SQLite-транзакцией: crash не может оставить run отмеченным как seen без сохранённого webhook.

Discord не предоставляет idempotency key. Поэтому доставка имеет стандартную для webhook семантику **at least once**: если Discord уже принял POST, а процесс аварийно завершился в несколько миллисекунд до записи `delivered_at` в SQLite, после restart возможен один повтор. При обычных poll, retry и redeploy уникальный ключ и outbox повтор не допускают.

Discord failure не роняет worker. Один HTTP-вызов имеет до трёх коротких retry для 429/5xx/network error, после чего outbox переносит следующую попытку на будущий цикл. Всего допускается шесть outbox attempts; неверный/удалённый webhook останавливает конкретное событие сразу, чтобы не создавать бесконечный spam.

## Что происходит после restart/redeploy

При подключённом Volume SQLite сохраняется. Worker поднимает недоставленный outbox, продолжает существующие baseline и не отправляет уже доставленные события. Изменения, произошедшие во время короткого простоя, будут замечены, если run всё ещё находится в верхних 20 строках соответствующего Speedrun.com feed.

Без Volume Railway filesystem ephemeral: после каждого redeploy будет создан новый baseline. Старые записи не заспамят канал, но события за время простоя могут быть пропущены.

## Обновление через GitHub

После первого GitHub deployment Railway автоматически следит за выбранной веткой:

```powershell
git add server
git commit -m "Add 24/7 webhook worker"
git push
```

Новый push собирает deployment. Volume остаётся тем же. Для monorepo можно настроить Watch Paths `/server/**`, чтобы изменения только desktop-части не пересобирали worker.

## Railway и SQLite

Для одного небольшого worker SQLite + Volume проще и дешевле PostgreSQL: нет отдельного DB service, сетевого подключения и миграционной инфраструктуры. Минусы: одна replica и короткий downtime при deployment, потому что два deployment одновременно не могут монтировать один Volume. PostgreSQL имеет смысл при нескольких workers, нескольких сервисах-писателях или требовании к независимой доступности базы.

Railway подходит для постоянного worker, но Free/Trial не равны гарантированному 24/7: на них недоступен restart policy `Always`, ограничены credits/resources, а Trial заканчивается. Практический минимум для постоянно работающего процесса — Hobby; цены и ограничения нужно сверить на <https://railway.com/pricing> перед deployment.

## Ограничения Speedrun.com API

- Каждый feed повторяет desktop-логику и читает только верхние 20 глобальных строк. Очень большой глобальный burst между poll может вытеснить нужный run.
- У rejected run API обычно не даёт `verify-date`, поэтому rejected feed сортируется по submission time. Позднее отклонение очень старого run может не попасть в верхние 20.
- Worker не придумывает URL из run ID. Если API не дал корректный `weblink`, сообщение не отправляется.
- Server worker мониторит run/new/verified/rejected. Desktop video-provider checks остаются в desktop-приложении: они используют отдельную provider-specific логику и Twitch credentials.
