# Оргструктура компании

Локальное приложение для редактирования организационной структуры. Интерфейс работает через JSON API, данные хранятся в SQLite.

## Запуск

Требуется Python 3.10 или новее. Сторонние пакеты не нужны.

```bash
python server.py
```

Откройте в браузере:

```text
http://127.0.0.1:8000
```

При первом запуске автоматически создаётся `data/org_chart.db` и загружаются демонстрационные данные. Открытие `index.html` напрямую больше не поддерживается, поскольку браузер не может обращаться к SQLite без backend-сервера.

Дополнительные параметры:

```bash
python server.py --host 127.0.0.1 --port 8080
```

## Структура проекта

- `server.py` — локальный HTTP-сервер и API;
- `database.py` — схема SQLite, транзакции и серверная валидация;
- `demo-data.json` — начальное содержимое базы;
- `api.js` — клиент API;
- `app.js` — интерфейс, построение дерева и CSV;
- `index.html` — разметка;
- `styles.css` — оформление.

## Таблицы SQLite

### `people`

- `id` — глобально уникальный ID;
- `name`, `position`, `role`;
- `department_id` → `departments.id`;
- `manager_id` → `people.id`.

### `departments`

- `id` — глобально уникальный ID;
- `name`;
- `parent_department_id` → `departments.id`;
- `reports_to_id` → `people.id`;
- `head_id` → `people.id`.

Внешние ключи включены. Сервер дополнительно проверяет циклы, уникальность ID, принадлежность руководителя отделу и взаимоисключение `parent_department_id` / `reports_to_id`. Замена структуры выполняется одной транзакцией.

## API

- `GET /api/health` — состояние сервера и ревизия базы;
- `GET /api/structure` — вся структура;
- `PUT /api/structure` — атомарное сохранение;
- `POST /api/reset` — восстановление демоданных.

## CSV

Актуальные колонки:

```csv
entity,id,name,position,role,departmentId,managerId,parentDepartmentId,reportsToId,headId
```

Импорт старого формата `id,name,position,parentId,type` также поддерживается.

При первом подключении к новой базе приложение один раз переносит существующие корректные данные из прежнего `localStorage`.

## Deploy на Netlify Blobs

Production-версия использует Netlify Functions и хранит всю проверенную структуру одним JSON-объектом в Netlify Blobs. Локальный запуск через `python server.py` продолжает использовать SQLite.

Установка и локальная сборка:

```bash
npm install
npm run build
```

Для проверки Functions и Blobs:

```bash
npx netlify login
npx netlify init
npm run dev
```

Перед production deploy задайте секретный ключ редактирования в настройках Netlify:

```text
ORG_CHART_WRITE_KEY=<длинный случайный пароль>
```

При первой попытке изменить данные интерфейс запросит этот ключ и сохранит его только в `sessionStorage` текущей вкладки.

Деплой preview и production:

```bash
npm run deploy
npm run deploy:prod
```

Сборка публикует только `index.html`, CSS и браузерный JavaScript из папки `dist`. Python-файлы и локальная SQLite в deploy не включаются.
