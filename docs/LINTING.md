# Lint e qualidade

O SaveMe usa **pre-commit** como entrada única de lint. O comando roda em todos
os arquivos do projeto, estejam eles staged ou não:

```bash
make lint
```

O hook de git roda nos arquivos staged. A verificação completa continua sendo
`make lint`, e é ela que o CI usa.

## Instalação

```bash
make setup-lint
.venv/bin/pre-commit install
```

`make setup-lint` cria `.venv` com o `pre-commit` e instala as ferramentas Node
locais em `node_modules`. O `pre-commit` gerencia os ambientes Python dos hooks
(Ruff, ShellCheck, yamllint, Vulture).

Requisitos de desenvolvimento:

- Python 3.11+
- Node.js 22+
- `desktop-file-utils` (`desktop-file-validate`)
- GNOME Shell 50 para o E2E da extensão

## Comandos

```bash
make lint        # pre-commit em todos os arquivos
make test        # unitários GJS + testes Python do Omega
make e2e         # daemon + D-Bus + backup/restore
make e2e-extension
make tests       # test + e2e + e2e-extension
make verify      # lint + tests
```

Não existe `make architecture`. As regras de arquitetura fazem parte do
`omega-lint`, que é chamado pelo pre-commit dentro de `make lint`.

## Hooks

| Hook | O que cobre |
|---|---|
| `eslint` | GJS/ESM, imports não usados, variáveis mortas, segurança básica |
| `no-only-tests` | impede `describe.only`, `it.only`, `test.only` |
| `knip` | arquivos, exports e dependências JavaScript não usados |
| `stylelint` | CSS do app GTK e da extensão GNOME/St |
| `shellcheck` | scripts POSIX shell |
| `ruff` | lint e imports de Python |
| `vulture` | código morto em Python |
| `yamllint` | YAML (CI, configs) |
| `markdownlint` | documentação Markdown |
| `desktop-file-validate` | arquivos `.desktop` |
| `check-json`, `check-yaml`, `check-toml`, `check-xml` | sintaxe de configurações |
| `trailing-whitespace`, `end-of-file-fixer`, `mixed-line-ending` | higiene de arquivos |
| `check-added-large-files` | evita binários acidentais no git |
| `detect-private-key` | evita commit de chaves |
| `omega-lint` | regras de arquitetura específicas do SaveMe |

O ESLint define os globals do GJS (`print`, `printerr`, `imports`, `global`,
`ARGV`, etc.) e entende `gi://` e `resource://` como módulos externos.

## Omega lint

O `omega-lint` é o linter Python de regras próprias. Ele não é um `make
architecture`: é um hook do pre-commit.

```bash
python3 scripts/omega_lint.py
python3 scripts/omega_lint.py --list-rules
python3 scripts/omega_lint.py --update-baseline
```

Regras atuais:

- `src/domain`, `src/application` e `src/ports` não podem importar `gi://`;
- essas camadas não podem importar `src/adapters` nem `src/composition`;
- essas camadas não podem usar `Gio.*` nem `GLib.*`;
- a extensão não pode importar `src/` nem `app/`;
- o app não pode importar internals do daemon
  (`src/daemon.js`, `src/runner.js`, `src/supervisor.js`, etc.);
- código de produção não pode importar `tests/`;
- `Gio.Subprocess` só é permitido atrás de adapters/composição,
  `app/gateway` (`SystemLauncher`), `extension/system-launcher.js`, CLI e
  testes;
- `Gio.bus_get_sync` só é permitido nas fronteiras D-Bus;
- testes não podem usar `.only`;
- `extension/metadata.json` precisa dos campos obrigatórios do GNOME Shell.

### Baseline

O código atual ainda tem dívida arquitetural. O arquivo
`.omega-lint-baseline.json` registra a quantidade aceita de cada violação
existente. O hook falha em **novas** violações, mas não bloqueia o legado.

Quando uma dívida for removida, atualize o baseline para baixo:

```bash
python3 scripts/omega_lint.py --update-baseline
```

Não use `--update-baseline` para esconder código novo. O baseline deve encolher
a cada etapa da refatoração.

## Código morto e testes

- **Knip** encontra arquivos, exports e dependências JavaScript sem uso.
- **Vulture** encontra funções, classes e variáveis Python sem uso.
- **no-only-tests** impede que um teste focado esconda o resto da suíte.

Os três rodam no `make lint`.

## CI

O CI executa `make lint`, `make test`, `make coverage` e `make e2e`. O job de
pacote executa `make e2e-extension`.
