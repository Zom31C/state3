# Адаптер skillstate для opencode

Даёт opencode тот же внешний слой состояния Σ, что и расширение для Qwen Code:
задача разработки хранится в `.skillstate/<id>.json` проекта, патчи валидируются
MCP-сервером, а компактная Σ попадает в контекст модели — поэтому прогресс
переживает сжатие сессии и перезапуск.

Проверено для **opencode 1.18.26** (Windows). Источники фактов — пакет
`@opencode-ai/plugin@1.18.26`
(`C:\Users\<user>\.config\opencode\node_modules\@opencode-ai\plugin\dist\index.d.ts`)
и официальная документация `opencode.ai/docs/plugins`, `opencode.ai/docs/mcp-servers`.

## Состав

| Файл                    | Назначение                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `plugin/skillstate.js`  | плагин: инжекция Σ в системный промпт и в контекст сжатия, опциональный guard опасных действий, режим `--self-test` |
| `opencode.example.json` | пример блока `mcp` для подключения сервера skillstate                                                               |
| `AGENTS.md`             | блок процедурных правил P для агента (положить в корень проекта или объединить с существующим `AGENTS.md`)          |

## Установка

```bash
# 1. Собрать сервер в репозитории skillstate
cd D:\Projects\skillState
npm install && npm run build

# 2. Плагин — в каталог плагинов проекта (или глобально: ~/.config/opencode/plugins/)
mkdir .opencode\plugins
copy adapters\opencode\plugin\skillstate.js .opencode\plugins\skillstate.js

# 3. MCP-сервер — в конфигурацию проекта: скопировать блок mcp из примера
#    в opencode.json (или opencode.jsonc) и поправить пути на свои
copy adapters\opencode\opencode.example.json opencode.json

# 4. Правила P — в AGENTS.md проекта (скопировать или объединить)
copy adapters\opencode\AGENTS.md AGENTS.md

# 5. Проверка
opencode mcp list
node .opencode\plugins\skillstate.js --self-test D:\Projects\skillState
```

Каталоги плагинов, которые opencode загружает автоматически: `.opencode/plugins/`
(проект) и `~/.config/opencode/plugins/` (глобально); принимаются `.js` и `.ts`.
Плагин — именованный экспорт асинхронной функции (`export const Skillstate = async ({ project, client, $, directory, worktree }) => hooks`);
объекты `output` в хуках мутируются на месте.

## Что делает плагин

| Хук                                  | Действие                                                                                                             | Статус факта                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `experimental.session.compacting`    | `output.context.push(Σ)` — состояние попадает в промпт сжатия, поэтому прогресс не теряется при компакции            | документировано (docs/plugins)                     |
| `experimental.chat.system.transform` | `output.system.push(Σ)` — компактная Σ в системном промпте каждого запроса (аналог UserPromptSubmit-хука Qwen Code)  | есть в типах 1.18.26, в документации не описан     |
| `tool.execute.before` (opt-in)       | `throw` блокирует вызов `bash`/`write`/`edit`/`patch`, если `next.risk` активной задачи `destructive` или `external` | документировано (throw отменяет вызов инструмента) |

Переменные окружения:

| Переменная             | По умолчанию               | Назначение                                                                                                                 |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SKILLSTATE_ROOT`      | каталог проекта (см. ниже) | где искать `.skillstate/`                                                                                                  |
| `SKILLSTATE_STATE_DIR` | не задана                  | абсолютный путь каталога состояния; приоритетнее `SKILLSTATE_ROOT` и эвристики — для запуска opencode вне каталога проекта |
| `SKILLSTATE_NO_SYSTEM` | не задана                  | `1` — не инжектировать Σ в системный промпт (оставить только сжатие)                                                       |
| `SKILLSTATE_GUARD`     | не задана                  | `1` — включить блокировку опасных вызовов инструментов                                                                     |

Каталог проекта плагин определяет сам: сначала явный `SKILLSTATE_ROOT`, затем
первый подходящий из `directory`, `worktree`, `project.worktree`,
`process.cwd()`, где «подходящий» — абсолютный путь, не являющийся корнем
файловой системы. Если подходящих несколько, выигрывает тот, где уже лежит
`.skillstate/`. Проверка на корень нужна потому, что opencode 1.18.26 передаёт
`worktree: "/"` для проекта без git-репозитория (`project.id === "global"`), а
Bun считает `"/"` абсолютным путём — без неё состояние искалось в
`\.skillstate`. Выбранный каталог плагин логирует при загрузке
(`loaded (state: ...)`, видно с `--print-logs`).

Guard по умолчанию выключен: он намеренно прерывает вызов инструмента, и включать
его стоит там, где подтверждение опасных действий нужно enforce, а не только
рекомендовать. Второй уровень защиты — штатная система разрешений opencode
(диалоги подтверждения, `permission.ask`).

### Что плагин не читает

Запись задачи на диске несёт поля `skill` (навык, которому принадлежит Σ) и
`notation` (`plain` | `compact`). Плагин их **игнорирует**: из записи он берёт
только `id`, `updatedAt`, `state.status`, `state.next.risk` и сам `state`,
поэтому инжектируемый заголовок выглядит как `Task <id> (<status>):` — без имени
навыка и без напоминания о компактной нотации (сравните с `renderTaskHead` в
`src/tasks/render.ts`, который печатает и то, и другое). `SKILLSTATE_PROJECTS`
плагин тоже не читает: инжектируется один корень — выбранный эвристикой либо
заданный `SKILLSTATE_ROOT`/`SKILLSTATE_STATE_DIR`.

Инструментов это не касается: opencode подключает тот же сервер skillstate (в
`opencode.example.json` — через лаунчер расширения `bin/skillstate-mcp.mjs`,
который импортирует `dist/mcp/server.js`), поэтому агенту как
`skillstate_task_*` доступны навыки (`dev-task`, `supervise-task`), аргументы
`skill`/`notation`/`project`, path-ключи патчей (`{"plan[1].status":"done"}`) и
строки возможностей `skills:`/`projects:` в ответе `task_list`. Процедуру P
навыка и блок компактной нотации возвращает `task_show`. `SKILLSTATE_PROJECTS`
сервер берёт из своего окружения — окружения процесса opencode либо блока
`environment` его mcp-конфигурации (опция описана в docs/mcp-servers).

## Безопасность

- Плагин и сервер не исполняют shell/HTTP и не правят код: читаются и пишутся
  только файлы `.skillstate/`.
- `next.risk` в Σ помечает следующее действие (`safe` / `destructive` /
  `external`); правила P требуют запросить подтверждение пользователя до
  исполнения destructive/external.
- Любая ошибка чтения состояния приводит к «ничего не инжектировать», а не к
  падению сессии.

## Проверка и отладка

```bash
opencode mcp list                                       # сервер skillstate и его статус
node adapters\opencode\plugin\skillstate.js --self-test D:\Projects\skillState
npm run smoke:mcp -- --server extensions\skillstate\bin\skillstate-mcp.mjs   # 12 проверок сервера
```

- Инструменты MCP регистрируются с префиксом имени сервера (в конфигурации
  отключаются маской `"skillstate_*": false`), то есть в сессии это
  `skillstate_task_show`, `skillstate_task_patch` и т. д.
- Для логов плагин использует `client.app.log({ body: { service: 'skillstate', level, message } })`
  (уровни `debug`/`info`/`warn`/`error`) — `console.log` в плагинах не
  рекомендуется.
- Значения в конфигурации поддерживают подстановку `{env:VAR}`; подстановки пути
  к проекту нет, поэтому в `opencode.example.json` стоят явные абсолютные пути —
  замените их на свои. Аргумент `--root` можно не указывать: тогда сервер возьмёт
  `<cwd>/.skillstate`.
- `timeout` у local MCP-сервера по умолчанию 5000 мс; в примере выставлено 10000
  на первый холодный старт node.

### Сквозная проверка на локальной модели (без ключей API)

Локальная Ollama закрывает E2E без внешних провайдеров: провайдер объявляется в
`opencode.json`, после чего модель появляется в `opencode models` как
`ollama/<имя>`:

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "qwen3.8:27b": {} }
    }
  }
}
```

```bash
opencode run -m ollama/qwen3.8:27b --print-logs --log-level INFO "позови skillstate_task_list и назови goal активной задачи"
```

Признаки успешного прогона в логе: `loaded (state: <проект>\.skillstate, ...)`,
`evaluated permission=skillstate_task_list ... action=allow`, строка вызова
инструмента и ответ модели, цитирующий `goal` из инжектированной Σ.

## Ограничения

- `experimental.chat.system.transform` и `permission.ask` присутствуют в типах
  плагина 1.18.26, но не описаны в публичной документации: если в будущей версии
  opencode их уберут, плагин продолжит работать через
  `experimental.session.compacting` (инжекция в системный промпт просто
  перестанет происходить, ошибка логируется в debug).
- Прямой «инжекции в каждый пользовательский промпт» в opencode нет — Σ
  добавляется в системный промпт и в контекст сжатия; в остальном агент читает
  состояние инструментом `task_show`.
- Плагин не знает о навыках, нотации и чужих проектах (см. «Что плагин не
  читает»): в инжектируемом блоке нет имени навыка и напоминания о компактной
  нотации, а добавляется Σ только одного корня. Агент добирает остальное через
  `task_show` (процедура P и блок нотации) и `task_list` (навыки и проекты).
