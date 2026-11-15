# Testes

## Camadas automatizadas

```bash
make lint            # pre-commit em todos os arquivos (Omega incluso)
make test            # unitários GJS + testes Python do Omega
make coverage        # GJS lcov + resumo de linha/branch/função
make e2e             # daemon + D-Bus + sync real-time + backup/restore
make e2e-extension   # GNOME Shell headless + extensão ACTIVE + sync
make e2e-app         # daemon + Shell headless + janela GTK + soak de memória
make tests           # test + e2e + e2e-extension + e2e-app
make verify          # lint + tests
```

Detalhes dos linters e das regras de arquitetura: [LINTING.md](LINTING.md).
`make architecture` não existe; as regras de arquitetura são o hook
`omega-lint` dentro do `make lint`.

O E2E de daemon roda em `dbus-run-session`, com XDG temporário, daemon real,
D-Bus real, rclone real e arquivos reais. O E2E da extensão sobe um GNOME Shell
headless com monitor virtual e verifica que a extensão fica **ACTIVE**, sem
erros JS, e que o daemon sincroniza um arquivo. O E2E do app usa o mesmo Shell
headless, cria um job, abre a janela GTK real com `--smoke-test`, aplica um
snapshot do daemon, percorre as cinco views, roda um soak de snapshots
sintéticos com limite de RSS e valida a API de logs do daemon. O soak pode ser
ajustado com `SAVEME_APP_SOAK_ITERATIONS`, `SAVEME_SOAK_MAX_RSS_DELTA_MB` e
`SAVEME_SOAK_MAX_RSS_MB` (padrão 120 iterações/64 MiB de delta/512 MiB absolutos).

O GJS gera lcov nativo:

```bash
gjs --coverage-prefix=file://$PWD \
    --coverage-output=$PWD/build/coverage \
    -m tests/run.js
python3 scripts/coverage.py build/coverage/coverage.lcov ...
```

## Metas de cobertura

| Camada | Linha | Branch | Como validar |
|---|---:|---:|---|
| Domínio puro (`src/domain/`) | 95% | 95% | `make coverage` (gate) |
| Aplicação (`src/application/`) | 95% | 85% | `make coverage` (gate) |
| Adapters Gio/persistência/system (`src/adapters/`, exceto rclone) | 90% | 85% | `make coverage` (gate) |
| Adapter D-Bus (`src/adapters/dbus/`) | 90% | 85% | `make coverage` (gate) |
| Adapter rclone | integração/E2E | integração/E2E | `make e2e` + `make coverage` informativo |
| Daemon/supervisor | 90% | 85% | `DaemonService` unit + E2E de ciclo de vida |
| Núcleo legado (config, jobs, queue, paths, state, util) | 95% | 90% | testes unitários |
| Runner, watcher, rclone, volumes | 95% | 90% | integração + falhas simuladas |
| Daemon, supervisor, auth, D-Bus | 90% | 85% | E2E em D-Bus privado |
| App GTK | E2E/smoke | E2E/smoke | `make e2e-app` (Shell headless + `--smoke-test`) |
| Extensão GNOME | E2E headless | E2E headless | `make e2e-extension` |
| Provedores reais (Drive/OneDrive/Dropbox) | manual | manual | contas reais antes do release |

**95% em tudo, incluindo UI, extensão e APIs de nuvem, não é uma meta
realista nem útil neste stack.** O GJS lcov conta cada branch de `??`, `||`,
optional chaining, `await`, parâmetros default e caminhos defensivos de GI/GTK;
a UI e os provedores mudam fora do nosso controle. A meta é 95% de linha e 95%
de branch no domínio, 95% de linha e 85% de branch na aplicação, 90/85 nos
adapters e no daemon, e cobertura comportamental E2E nas superfícies visuais.

Estado atual (unit + integration + E2E de daemon):

- domínio puro: **99,0% linha / 95,4% branch / 100% funções**;
- aplicação: **98,7% linha / 85,0% branch / 100% funções**;
- adapters Gio/persistência/system: **97,2% linha / 90,7% branch / 100% funções**;
- adapter D-Bus (`DaemonApi`): **100% linha / 100% branch / 100% funções**;
- `src/` global: **80,0% linha / 66,1% branch**.

Os gates de domínio, aplicação, adapters e D-Bus rodam no `make coverage`.
O adapter rclone é um wrapper de subprocesso e é validado por integração/E2E,
não por branch coverage.

## Simulação de backup e restore

O E2E já cobre:

- sync inicial, update, diretório novo, rename, delete e troca de destino;
- backup incremental com `SaveMe/<job-id>/current` e `versions/<data>`;
- arquivo deletado preservado em versões;
- restauração de arquivo deletado por data;
- restauração do backup atual inteiro;
- restart graceful do daemon com estado e jobs preservados;
- pause/resume com bloqueio de mudanças em tempo real;
- sinal `SnapshotChanged`;
- kill -9 do daemon e recuperação de jobs/estado;
- app GTK headless recebendo snapshot real, renderizando todas as views e
  passando pelo soak de memória;
- extensão ACTIVE em GNOME Shell headless com sync real;
- retenção, limpeza e sanitização de logs via D-Bus;
- sync remoto grande bloqueado por espaço local insuficiente;
- browser remoto recusando pasta com muitas entradas;
- backup multi-origem, manifesto, recuperação e restore para outra pasta;
- reutilização da mesma base por um segundo job, com pastas por `job-id`.

Próximos cenários:

- remoto simulado com `rclone serve webdav` (inclui queda/retomada);
- kill -9 do daemon no meio de um backup;
- disco removido no meio de um sync;
- arquivos com Unicode, espaços, symlinks, caminhos longos e arquivos grandes;
- restore dry-run e colisão de destino;
- provider OAuth com respostas gravadas + validação manual real.

## Automatizados

```bash
make verify
```

Cobre:

- lint completo, incluindo ESLint, Stylelint, ShellCheck, Ruff, Vulture, Knip,
  Markdownlint, validação de `.desktop` e regras do Omega;
- testes Python do próprio Omega lint;
- `make test` também roda um dry-run do instalador, sem `sudo`/`apt`, cobrindo
  install, update, app-only e uninstall normal/purge;
- domínio puro: layout de backup, retenção, delete guard, change batcher,
  comandos rclone, parser de log, jobs e transições de estado;
- application services com fakes de transfer/filesystem/state/clock:
  full e incremental sync, full e incremental backup, delete guard,
  cancelamento, retries, restore e limpeza de versões;
- DaemonService/DaemonApi com fakes de config/state/manager/auth/transfer;
- política de logs pura (sanitização, idade, tamanho e sumarização);
- LogService com store fake e LogStore real: inventário, prune, clear e
  sanitize;
- rotação e sanitização de logs (Logger, raw log e app log);
- métricas de `/proc`, CPU por intervalo e monitor de memória do app;
- Scheduler, RetryPolicy e JobStateMachine puros;
- pré-checagem de espaço em disco (margem, mínimo e fator de backup);
- pré-checagem de cota remota via `rclone about` quando disponível;
- monitoramento de RSS/pico/CPU do daemon e exposição no snapshot;
- métricas de CPU/memória da máquina via `/proc`;
- manifesto de backup, importação de jobs recuperados e validação de fontes;
- backup multi-origem e notificação de conclusão por job;
- adapters Gio: filesystem, raw log, relógio, paths e run repository;
- adapter D-Bus: conversão de booleanos e delegação;
- gateways do app (`DaemonGateway`, `SystemLauncher`) e da extensão
  (`SaveMeDaemonClient`) com fakes;
- formatação/view models puros do app e da extensão;
- property-based tests para paths de backup, retenção e delete guard;
- utilidades, configuração e validação de jobs;
- fila/debounce do watcher;
- sync completo, sync incremental, dry-run;
- backup com versões e retenção;
- guarda de deleção (full e incremental);
- origem vazia/ausente;
- filtros padrão;
- watcher real com criação, alteração, rename e delete;
- E2E do daemon, do app e da extensão.

O CI roda os mesmos componentes em `.github/workflows/ci.yml`.

## Manual — antes de publicar

Use uma instalação limpa do Ubuntu 26.04.

### Instalação

- [ ] `sudo apt install ./dist/saveme_*.deb`
- [ ] O daemon inicia no login ou com `saveme-daemon &`
- [ ] `saveme doctor` mostra rclone e paths corretos
- [ ] `saveme-settings` abre
- [ ] Extensão instala pelo EGO ou pelo zip e fica **ACTIVE**
- [ ] Ícone aparece no painel e o popup abre sem erros

### Logs e memória

- [ ] Abrir Logs: uso total, retenção e tamanho do app log corretos
- [ ] Clean up remove logs antigos e mostra bytes liberados
- [ ] Clear run logs e daemon log funcionam após confirmação
- [ ] Sanitize redige token antigo em log existente
- [ ] Editar a política em Settings, salvar e ver o novo valor após reabrir
- [ ] Settings/Debug mostram RSS, pico, CPU e status do orçamento
- [ ] `app.log` contém amostras periódicas e nenhum segredo
- [ ] `make e2e-app` passa com o soak abaixo do limite de 64 MiB
- [ ] Desinstalar sem `--purge` remove logs/caches/temporários e preserva jobs
- [ ] Desinstalar com `--purge` remove config, estado, cache e log do instalador

### Contas

- [ ] Google Drive: adicionar, abrir URL, autorizar, testar job
- [ ] OneDrive pessoal: adicionar, autorizar, testar job
- [ ] OneDrive business: selecionar Business, autorizar, testar job
- [ ] Dropbox: adicionar, autorizar, testar job
- [ ] Reautenticar uma conta existente
- [ ] Remover conta sem jobs; tentar remover conta em uso (deve falhar)

### Sync local

- [ ] Criar, editar, renomear e apagar arquivos; destino reflete em < 5 s
- [ ] Salvar arquivo por editor com escrita atômica; sem arquivos temporários
- [ ] Diretório novo e diretório removido
- [ ] Dry run reporta cópias e deletes sem alterar o destino
- [ ] Apagar mais que o limite; job bloqueia e notifica
- [ ] Forçar após revisar; job aplica

### Backup local

- [ ] Alterar o mesmo arquivo 3 vezes; versões anteriores existem
- [ ] Restaurar backup atual inteiro
- [ ] Navegar por uma versão por data e restaurar um arquivo
- [ ] Dry run de restore não escreve
- [ ] Apagar na origem; o arquivo vai para `versions` e pode ser restaurado
- [ ] Retenção remove versões antigas
- [ ] Pasta final: `<destino>/SaveMe/<job-id>/current` e `.../versions`

### Nuvem

- [ ] Sync local → Drive/OneDrive/Dropbox
- [ ] Sync nuvem → local (polling de 5 min)
- [ ] Sync da raiz do Drive para disco local com espaço insuficiente: job para
      como `no-space`, não escreve e mostra livre/exigido no Logs
- [ ] Browser remoto de pasta com >2.000 entradas pede para abrir subpasta
- [ ] Backup para OneDrive com duas pastas locais; conferir
      `SaveMe/<job-id>/current/<fonte>/`
- [ ] Criar outro job no mesmo destino; deve criar outra pasta de job
- [ ] No app, abrir **Recover backup**, escolher a pasta `SaveMe`, importar o
      job e restaurar para uma pasta local diferente
- [ ] Sync nuvem → nuvem
- [ ] Backup local → nuvem com versões
- [ ] Ficar offline; job tenta com backoff e recupera depois
- [ ] Cancelar job em andamento
- [ ] Trocar a pasta de destino de um job Sync pela edição; novo espelho começa nela

### Discos removíveis

- [ ] Job com origem em disco removível
- [ ] Desconectar no meio; job pausa e não apaga o destino
- [ ] Reconectar; job reconcilia e volta ao tempo real
- [ ] Destino removível desconectado; job espera e retoma

### Ciclo de vida

- [ ] Suspend/resume
- [ ] Reiniciar a máquina; estado e jobs persistem
- [ ] Desabilitar/habilitar job
- [ ] Pausar tudo / retomar tudo
- [ ] Fechar o app; daemon continua
- [ ] Reiniciar a sessão GNOME; watcher volta
- [ ] Desinstalar o `.deb`; dados do usuário permanecem

### Extensão

- [ ] Status e progresso no popup
- [ ] Run now, pause/resume, cancel
- [ ] Abrir configurações
- [ ] Abrir logs de um job
- [ ] Daemon parado mostra estado explicativo
