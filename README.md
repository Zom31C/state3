# skillState

Автономный рантайм **SKILL.state** (arXiv:2608.26263 «SKILL.state: Scalable Long-Horizon Agent Skills») поверх моделей Qwen. Полный план работ — в [PLAN.md](./PLAN.md), план интеграции в реальные кодинг-агенты (Qwen Code, opencode) — в [INTEGRATION.md](./INTEGRATION.md).

Идея: вместо растущего транскрипта диалога агент на каждом шаге получает `(P, Σ, O)` — неизменные инструкции, компактное структурированное состояние и последнее наблюдение — и возвращает `{state_patch, action}`. Промпт остаётся 𝒪(1), состояние валидируется детерминированным рантаймом.

## Статус

Готовы Фазы 0–4 (см. [PLAN.md](./PLAN.md)):

- **Фаза 0** — каркас, конфигурация, LLM-провайдеры (Ollama, DashScope, OpenRouter)
- **Фаза 1** — ядро рантайма: `StateStore` (⊕-слияние, null-удаление, откат), парсер `{state_patch, action}`, zod-валидатор с guard'ом, шаблоны промптов A.1–A.4, цикл Algorithm 1 с retry-политикой
- **Фаза 2** — складской бенчмарк (детерминированный генератор событий по Algorithm 2, телеметрия-шум, скоринг против ground truth), навык склада (500 полок, strict-схема, guard преждевременной перезаписи), CLI-раннер с метриками статьи
- **Фаза 3** — бейзлайны Prompt (ReAct) / Memory (NL-суммаризация + окно 3 хода) / Stateful (состояние + полный транскрипт), матричный раннер (рантаймы × горизонты × сиды) со сводной таблицей
- **Фаза 4** — устойчивость: невалидный шаг деградирует без разрушения состояния, агрегация режимов ошибок (`errorCounts`), structured output (`--structured`: JSON-schema constrained decoding — `format` в Ollama, `response_format` в OpenAI-совместимых API)

Демо на локальной `qwen3.8:27b` (склад, T=10, seed 42): точность 1.0 у всех рантаймов, при этом SKILL.state — минимальный промпт (2059 симв. в среднем, у статьи 1905) и минимум токенов (7.7K против 10.3–11.3K у бейзлайнов). Подробности — в PLAN.md §7.

## Интеграция в реальные кодинг-агенты (Фазы 5–9)

Тот же механизм применяется к задачам разработки: агент ведёт внешнее состояние Σ вместо опоры на транскрипт, поэтому прогресс переживает сжатие сессии и перезапуск. Фазы 5–9 готовы (итоги, метрики dogfood-прогона и таксономия рисков — в §9–§10 плана [INTEGRATION.md](./INTEGRATION.md)):

- **Фаза 5** — task-state ядро: схема `DevTaskState` (`goal`, `status`, `plan`, `artifacts`, `verifications`, `decisions`, `blockers`, `next{action,risk}`), доменный guard (задачу в `done` нельзя переоткрыть; выполненный пункт плана — только с пояснением в `notes`; `blocked` требует непустого `blockers`), `TaskStore` с атомарной записью и аудит-историей, CLI-подкоманда `task`
- **Фаза 6** — MCP-сервер `skillstate` (stdio, SDK 1.30.0): инструменты `task_start`, `task_show`, `task_patch`, `task_finish`, `task_list`, `task_history`; патчи валидируются до записи, отвергнутый патч возвращает диагностику и не трогает состояние
- **Фаза 7** — Qwen Code extension: MCP-сервер + хуки `UserPromptSubmit`/`PreCompact`/`SessionStart` (инжектируют компактную Σ в контекст) + навык `/long-task` (процедура P). Проверено вживую: `qwen mcp list` → Connected, хуки отрабатывают, модель видит Σ и все шесть инструментов
- **Обобщение (09.09.2026)** — ядро больше не привязано к домену «задача разработки»: реестр навыков (`dev-task`, `supervise-task`), корни состояния нескольких проектов (`--project` / `SKILLSTATE_PROJECTS`), компактная нотация Σ и path-ключи патчей. Подробности — §11 [INTEGRATION.md](./INTEGRATION.md)

### Состояние задачи из командной строки

```bash
npm run run -- task start "Миграция на zod 4" --plan "Найти использования" --plan "Правки" --plan "Тесты"
npm run run -- task start "Проверка работы субагента" --skill supervise-task --notation compact
npm run run -- task show                       # активная задача (или --id <id>)
npm run run -- task patch "{\"plan\":[...]}"   # патч JSON-строкой: массив целиком
npm run run -- task patch "{\"plan[1].status\":\"done\"}"  # ...или один элемент массива
npm run run -- task patch - < patch.json       # ...или из stdin
npm run run -- task list
npm run run -- task history --limit 10         # аудит, включая отвергнутые патчи
npm run run -- task finish "Миграция завершена, тесты зелёные"
```

Состояние хранится в `.skillstate/<id>.json`, история патчей — в `.skillstate/<id>.history.jsonl` (каталог в `.gitignore`). Флаг `--root <dir>` задаёт другой каталог состояния.

`--skill` выбирает схему Σ, доменные правила и процедуру: `dev-task` (по умолчанию) — работа в этом проекте, `supervise-task` — проверка работы другого агента. `--notation compact` предписывает писать значения Σ сжатым псевдокодом: Σ реинжектируется каждый ход, поэтому её размер — повторяющаяся стоимость. Path-ключи (`plan[1].status`, `plan[+]`, `rounds[0].verdict`) меняют один элемент массива без переотправки массива; раскрываются они до guard'а и схемы, поэтому обойти доменное правило path-ключом нельзя.

`--project <name>` берёт корень состояния другого проекта из `SKILLSTATE_PROJECTS` (`name=dir;name2=dir2`, разделитель `;` или перевод строки, либо JSON-объект) — так супервизор читает и патчит Σ рабочего агента в чужом каталоге. Достижимы только объявленные корни: модель выбирает имя из списка, а не задаёт путь. Те же аргументы (`skill`, `notation`, `project`) есть у MCP-инструментов.

### Подключение к Qwen Code

```bash
npm run build                                        # нужен dist/mcp/server.js
qwen extensions link D:\Projects\skillState\extensions\skillstate
qwen mcp list                                        # ✓ skillstate ... - Connected
```

Запускайте `qwen` из каталога проекта: каталог состояния — это `<cwd>/.skillstate`, а `cwd` сервера равен **каталогу запуска** Qwen Code (переменной для каталога проекта в 0.22.3 нет: `${workspacePath}` — тот же каталог запуска, `${workspaceFolder}` не поддерживается, MCP `roots` клиент не объявляет). Хук берёт каталог из поля `cwd` своего stdin-payload, поэтому правило для него то же. Если запуск из другого места неизбежен, задайте `SKILLSTATE_STATE_DIR=<проект>\.skillstate` — её учитывают сервер, хуки и плагин opencode. Расхождение больше не тихое: инструменты называют свой корень (`no tasks (state root: …)`, `Started task <id> [<skill>] at <path>`). `/cd <проект>` и `/reload-plugins` корень не исправят: они не пересоздают дочерний процесс MCP-сервера (измерено — pid и время старта не меняются), хотя хуки сразу начинают читать Σ нового каталога сессии. По той же причине живой сервер не подхватывает пересборку: после `npm run build` запущенная сессия исполняет старый код (измерено 09.09.2026 — path-ключи отвергались как `unknown-key` до перезапуска `qwen`).

Переменная `SKILLSTATE_PROJECTS` объявляет дополнительные корни состояния (`name=dir;name2=dir2` или JSON-объект): инструменты получают аргумент `project`, а хук инжектирует активную задачу каждого объявленного проекта блоком `## Supervised projects (skillstate)`. Достижимы только объявленные корни — модель выбирает имя, а не путь.

Подробности, проверка хуков и подводные камни — в [extensions/skillstate/README.md](./extensions/skillstate/README.md). Адаптер для opencode — в [adapters/opencode/](./adapters/opencode/).

### MCP-сервер без хоста

```bash
npm run build
npm run smoke:mcp                # 12 проверок через stdio-клиент во временном каталоге
npm run smoke:mcp -- --server extensions\skillstate\bin\skillstate-mcp.mjs
node dist\mcp\server.js --help
```

## Требования

- Node.js ≥ 20
- Для локального провайдера: установленный [Ollama](https://ollama.com) (`ollama pull qwen3.8:27b` или другая модель)
- Для облачных провайдеров: ключ `DASHSCOPE_API_KEY` или `OPENROUTER_API_KEY`

## Быстрый старт

```bash
npm install
npm test          # юнит-тесты (без сети)
npm run lint
npm run typecheck

# Дымовой вызов модели
npm run smoke                             # PROVIDER из .env (по умолчанию ollama)
npm run smoke -- --provider ollama --model qwen3.8:27b
npm run smoke -- --provider dashscope --prompt "Say hi"

# Прогон складского навыка (метрики: точность / размер промпта / токены)
npm run run -- --horizon 20 --seed 42 --out results/run.json
npm run run -- --horizon 100 --provider ollama --max-retries 3 --quiet

# Отдельный бейзлайн (prompt | memory | stateful | skillstate)
npm run run -- --runtime prompt --horizon 20

# Structured output: constrained decoding (Ollama format / response_format)
npm run run -- --horizon 20 --structured

# Матрица: рантаймы × горизонты × сиды, сводная таблица
npm run run -- --horizons 50,100 --seeds 42,43 --out results/matrix.json
npm run run -- --runtime memory --horizons 50 --seeds 42,43,44 --memory-window 3 --summarize-every 5
```

## Конфигурация

Скопируйте `.env.example` в `.env`. Переменные окружения:

| Переменная           | Назначение                              | По умолчанию                 |
| -------------------- | --------------------------------------- | ---------------------------- |
| `PROVIDER`           | `ollama` \| `dashscope` \| `openrouter` | `ollama`                     |
| `MODEL`              | общая перегрузка модели                 | см. ниже                     |
| `OLLAMA_BASE_URL`    | адрес Ollama                            | `http://localhost:11434`     |
| `OLLAMA_MODEL`       | модель Ollama                           | `qwen3.8:27b`                |
| `DASHSCOPE_API_KEY`  | ключ DashScope                          | — (обязателен)               |
| `DASHSCOPE_MODEL`    | модель DashScope                        | `qwen-plus`                  |
| `OPENROUTER_API_KEY` | ключ OpenRouter                         | — (обязателен)               |
| `OPENROUTER_MODEL`   | модель OpenRouter                       | `qwen/qwen-2.5-72b-instruct` |

Декодирование зафиксировано по статье: `temperature = 0`, `top_p = 1`.

## Скрипты

| Команда             | Назначение                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`          | прогон тестов (vitest)                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run typecheck` | проверка типов всего проекта (`tsc --noEmit`)                                                                                                                                                                                                                                                                                                                                                           |
| `npm run lint`      | ESLint                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run build`     | компиляция `src/` в `dist/`                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run run`       | прогон навыка (`--horizon`, `--seed`, `--provider`, `--model`, `--max-retries`, `--out`, `--quiet`) или подкоманда `task` (`start`, `show`, `patch`, `finish`, `list`, `history`; `--root`, `--id`, `--limit`, `--plan`, `--skill`, `--notation`, `--project`, `-h`/`--help`). `task list` последней строкой печатает `runtime:` — версию и каталог сборки, с пометкой `STALE`, если `src` новее `dist` |
| `npm run smoke`     | дымовой вызов провайдера (`--provider`, `--model`, `--prompt`)                                                                                                                                                                                                                                                                                                                                          |
| `npm run smoke:mcp` | сквозная проверка MCP-сервера через stdio-клиент (12 проверок; `--server <path>` — другая точка входа)                                                                                                                                                                                                                                                                                                  |
