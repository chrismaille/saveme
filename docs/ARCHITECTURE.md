# SaveMe — Arquitetura

Documento técnico da v1.0. A especificação de produto e os critérios de
aceitação estão em [SPEC.md](SPEC.md).

## 1. Visão geral

```
┌──────────────────────────────┐
│ Extensão GNOME (GJS)         │
│ painel + popup + ações       │
└──────────────┬───────────────┘
               │ D-Bus (sessão)
┌──────────────▼───────────────┐       ┌─────────────────────────────┐
│ saveme-daemon (GJS)          │──────▶│ rclone (binário pinado)     │
│ systemd --user               │       │ OAuth, transferência, retry │
│ config, scheduler, watcher,  │       └─────────────────────────────┘
│ runner, estado, logs         │
└──────────────▲───────────────┘
               │ D-Bus (sessão)
┌──────────────┴───────────────┐
│ SaveMe Settings (GTK4/Adwaita)│
│ jobs, contas, logs, restore  │
└──────────────────────────────┘
               ▲
               │ D-Bus
        ┌──────┴──────┐
        │ CLI saveme  │
        └─────────────┘
```

### Decisões estruturais

1. **A extensão é só UI.** Extensões rodam no processo do GNOME Shell; I/O,
   cópia e rede ali travariam o desktop e morreriam a cada restart do Shell.
2. **Daemon separado.** Agenda, executa, persiste estado e sobrevive à UI.
3. **rclone como motor.** Não reimplementamos Google Drive, OneDrive, Dropbox,
   OAuth, chunks, retries ou rate limits.
4. **GJS em tudo.** Daemon, app e extensão usam a mesma linguagem e o mesmo
   runtime já presente no Ubuntu 26.04.
5. **Um único entregável v1.0.** A implementação é organizada por módulos, mas
   o release só sai quando o SPEC inteiro passar.

## 2. Stack verificada

Ambiente de desenvolvimento (máquina do projeto):

- Ubuntu 26.04.1 LTS
- GNOME Shell 50.1
- GJS 1.88.0
- GTK 4.22, libadwaita 1.9
- rclone do apt: 1.60.1
- rclone atual: 1.76.0

O rclone do Ubuntu é antigo demais para um app publicável. A decisão é
**empacotar um rclone pinado** em `/usr/lib/saveme/bin/rclone`, com fallback
para `SAVEME_RCLONE` e para o `rclone` do PATH. O binário bundled entra no
`.deb` com a licença MIT; a extensão do EGO não contém binário.

## 3. Identificadores

- App ID: `io.github.chrismaille.SaveMe`
- Daemon: `io.github.chrismaille.SaveMe.Daemon`
- Settings: `io.github.chrismaille.SaveMe.Settings`
- Extensão: `saveme@chrismaille.github.io`
- D-Bus name: `io.github.chrismaille.SaveMe.Daemon`
- D-Bus path: `/io/github/chrismaille/SaveMe/Daemon`
- Binários: `saveme`, `saveme-daemon`, `saveme-settings`
- Pacote: `saveme`

## 4. Layout do repositório

```
extension/            extensão GNOME (zip do EGO)
  metadata.json
  extension.js        painel, popup e orquestração
  daemon-client.js    gateway D-Bus com deduplicação de snapshot
  system-launcher.js  gateway de processos (abrir Settings/Logs)
  presentation.js     view model puro (status, progresso, textos)
  ui/                 widgets St (JobRow, ProgressBar)
  stylesheet.css
  icons/
  locale/
app/                  SaveMe Settings (GTK4/Adwaita)
  main.js
  window.js           composição da janela e navegação entre views
  gateway/            DaemonGateway e SystemLauncher
  presentation/       formatação pura (bytes, datas, status, ETA)
  pages/              JobsPage, AccountsPage, LogsPage, SettingsPage,
                      DebugPage
  widgets/            helpers GTK compartilhados (status, linhas, read tail)
  job-editor.js       diálogos de job, conta, restore, logs e browser
  style.css
src/                  daemon e bibliotecas compartilhadas internas
  domain/             regras puras, sem gi:// (backup, retenção, delete guard,
                      change batching, comandos rclone, parser de log, erros)
  ports/              contratos runtime dos ports (transfer, fs, clock, state…)
  adapters/           implementações GI/rclone/JSON/system
    rclone/           transfer engine
    gio/              filesystem, raw log, watcher, volumes
    persistence/      config, state e runs
    system/           clock, logger, paths
    dbus/             DaemonApi fino
  application/        SyncService, BackupService, RestoreService,
                      RunCoordinator, RunExecutor, DaemonService,
                      Scheduler, change planner
  composition/        montagem do runner para daemon e CLI
  main.js
  application.js
  config.js
  state.js
  jobs.js
  scheduler.js
  watcher.js
  queue.js
  runner.js           fachada fina sobre RunCoordinator
  supervisor.js       JobManager/JobSupervisor sobre Scheduler/RetryPolicy
  auth.js
  volumes.js
  restore.js
  log.js
  notify.js
  paths.js
  util.js
  dbus.js
bin/                  saveme, saveme-daemon, saveme-settings
data/                 .desktop, systemd, D-Bus service, ícones
po/                   traduções
tests/                unitários, integração, E2E e smoke
tools/                rclone baixado para dev (não versionado)
docs/
debian/               empacotamento .deb
Makefile
```

Durante a Fase 4, o supervisor usa `Scheduler`, `RetryPolicy` e
`JobStateMachine` puros; o daemon ficou dividido entre ciclo de vida
(`daemon.js`), `DaemonService` (casos de uso) e `DaemonApi` (adapter D-Bus).

Na Fase 5, as duas UIs passaram a ter o mesmo desenho: gateway na borda,
view model puro e widgets sem D-Bus. A extensão fala com o daemon somente por
`SaveMeDaemonClient`; `JobRow`/`ProgressBar` só consomem `presentation.js`;
abrir o app passa por `system-launcher.js`.
O app fala somente por `DaemonGateway` e `SystemLauncher`; as páginas recebem
a janela e não importam `DaemonClient` nem `Gio.Subprocess`. O contrato D-Bus
continua inalterado.

## 5. Configuração, estado e logs

Tudo em XDG:

- Config: `~/.config/saveme/config.json`
- rclone: `~/.config/saveme/rclone.conf` (`0600`)
- Estado: `~/.local/state/saveme/state.json`
- Execuções: `~/.local/state/saveme/runs/<job-id>/<run-id>.json`
- Logs: `~/.local/state/saveme/logs/<job-id>/<run-id>.log`
- Log bruto do rclone: `.../<run-id>.rclone.jsonl`
- Cache: `~/.cache/saveme/`
- Runtime: `$XDG_RUNTIME_DIR/saveme/`

Config e estado são JSON versionados, validados e gravados com
`g_file_replace_contents` (atômico). O daemon mantém um backup `.bak` da última
configuração válida.

## 6. Modelo de dados

Ver o exemplo completo em [SPEC.md](SPEC.md#4-modelo-de-job).

Entidades:

- **Remote**: nome, tipo, label, conta. O segredo fica no `rclone.conf`.
- **Job**: origem, destino, tipo, trigger, filtros, opções, retenção.
- **Run**: id, job, kind (`sync`, `backup`, `reconcile`, `dry-run`, `restore`),
  início/fim, resultado, exit code, estatísticas, arquivos com erro, log.
- **JobState**: status, último run, próximo run, progresso, mensagem.

Status do job:

```
idle | running | paused | waiting-source | waiting-destination |
offline | error | needs-auth | disabled
```

## 7. D-Bus

Interface `io.github.chrismaille.SaveMe.Daemon`:

Métodos:

```
GetSnapshot() -> s                       # JSON: settings, remotes, jobs, states
RunJob(s job_id, b dry_run) -> s         # run_id
CancelJob(s job_id)
SetJobEnabled(s job_id, b enabled)
PauseAll(b paused)
GetRun(s job_id, s run_id) -> s          # JSON
GetRunLog(s job_id, s run_id) -> s
ListVersions(s job_id) -> s              # JSON
Restore(s payload_json) -> s             # operation_id
CancelOperation(s operation_id)
BeginRemoteAuth(s provider, s name) -> s # auth_id
GetRemoteAuth(s auth_id) -> s            # JSON: waiting|url|done|error
CancelRemoteAuth(s auth_id)
CreateRemote(s payload_json) -> s
DeleteRemote(s name)
Doctor() -> s                            # JSON
```

Sinais:

```
SnapshotChanged(s json)                  # throttle de 1 Hz
RunFinished(s job_id, s run_id, s json)
RemoteAuthChanged(s auth_id, s json)
```

Payloads complexos são JSON para simplificar o GVariant no GJS e permitir
evolução sem quebrar a interface. A extensão usa apenas `GetSnapshot`,
`RunJob`, `CancelJob`, `SetJobEnabled` e `PauseAll`.

Na Fase 4, `adapters/dbus/api.js` é um adapter fino: cada método converte
booleanos/GVariant e delega ao `DaemonService`. O contrato completo está em
`src/dbus.js`; o daemon só cuida de ciclo de vida, sinais, notificações,
energia e rede.

## 8. Watcher em tempo real

Implementação em `src/watcher.js` usando `Gio.FileMonitor`.

- Monitoramento não é recursivo no Gio; o watcher cria um monitor por diretório
  e adiciona monitores para diretórios novos.
- Flags: `Gio.FileMonitorFlags.WATCH_MOVES`.
- Eventos:
  - `CHANGES_DONE_HINT` → upsert
  - `CREATED` → se diretório, adiciona monitor; se arquivo, upsert
  - `DELETED` → delete
  - `RENAMED` → delete do caminho antigo + upsert do novo
  - `MOVED_IN` → upsert (ou monitor, se diretório)
  - `MOVED_OUT` → delete
  - `ATTRIBUTE_CHANGED` → upsert se `preserveMetadata`
- Escritas atômicas geram arquivos temporários; o watcher ignora nomes como
  `.goutputstream-*`, `*.tmp`, `*.partial`, `~$*`, `.*.swp`.
- Debounce de 1 s e coalescência por caminho. No processamento, o arquivo é
  revalidado: se não existe mais, o evento é descartado.
- Lotes grandes (> 500 mudanças) viram reconciliação completa.
- Limite de inotify: lê `/proc/sys/fs/inotify/max_user_watches`. Se a árvore
  passar de 80% do limite, cai para polling e avisa no Doctor.
- Origem na nuvem não tem inotify; o job usa polling de 5 min.
- Reconciliação completa periódica (24 h) corrige eventos perdidos.

## 9. Runner e rclone

A execução é dividida em `application/SyncService`, `BackupService`,
`RestoreService` e `RunCoordinator`. O `JobRunner` é uma fachada fina; os
serviços dependem de ports (`TransferEngine`, `FileSystem`, `StateRepository`,
`RunRepository`, `Clock`, `Paths`) e nunca de `Gio`/`rclone` diretamente. A
montagem concreta fica em `composition/runner.js`; os adapters ficam em
`adapters/rclone` e `adapters/gio`.

Cada execução é um subprocesso `rclone` com argv (nunca shell). Flags comuns:

```
--config ~/.config/saveme/rclone.conf
--use-json-log
--stats 1s
--stats-log-level NOTICE
--log-level INFO
--retries 3
--low-level-retries 10
--timeout 5m
--contimeout 1m
--filter-from <filtros>
--create-empty-src-dirs
```

Operações:

- **Reconciliação Sync**: `rclone sync origem destino --max-delete N`, com um
  dry-run interno antes para abortar sem tocar no destino se o limite for
  excedido.
- **Reconciliação Backup**: `rclone copy origem destino --backup-dir <versões>`
- **Upsert incremental Sync**: `rclone copy origem destino --files-from <lista>`
- **Delete incremental Sync**: `rclone delete destino --files-from <lista>` e
  `rclone purge destino/<dir>` para diretórios removidos
- **Upsert incremental Backup**:
  `rclone copy origem destino --files-from <lista> --backup-dir <versões>`
- **Dry-run**: acrescenta `--dry-run`; estatísticas alimentam o resumo.
- **Restore**: `rclone copy <destino ou versão> <alvo>` com dry-run opcional.

Por que não usar `rclone sync --files-from` para mudanças incrementais? Porque
o `sync` com lista parcial pode interpretar o restante do destino como extra e
apagar tudo. Upserts e deletes são operações explícitas e separadas.

Progresso:

- O daemon lê o stdout mesclado do rclone linha a linha.
- Linhas JSON com `stats` atualizam bytes, arquivos, velocidade, ETA e erros.
- Linhas `Copied`, `Deleted`, `Renamed` viram eventos de log.
- Exit codes do rclone são mapeados; `0` e “no files transferred” são sucesso,
  o resto vira erro com mensagem acionável.

Cancelamento: SIGINT, espera de 10 s, SIGTERM. Estado e logs são finalizados
mesmo em cancelamento.

## 10. Versionamento

O modo Backup usa `--backup-dir` e mantém duas árvores irmãs dentro da pasta
base escolhida:

```
<destino>/SaveMe/<job-id>/current/<caminho-relativo>
<destino>/SaveMe/<job-id>/versions/<YYYYMMDDTHHMMSS>-<mmm>-<run>/<caminho-relativo>
```

Para remotes, o caminho equivalente é
`<remote>:<destino>/SaveMe/<job-id>/...`.

- `current` é o espelho do último backup. O full backup usa `rclone sync`
  origem → current; delete/overwrite vão para o `--backup-dir`.
- `versions` guarda apenas arquivos sobrescritos ou removidos naquele lote;
  não é um snapshot completo.
- No incremental, upserts usam `copy --backup-dir`; arquivos removidos são
  movidos de `current` para o diretório de versão com `rclone move`.
- Retenção: remove diretórios de versão antigos com `rclone purge`, após cada
  backup.
- Restore:
  - backup atual inteiro: `rclone copy current <target>`;
  - arquivo/pasta de uma versão: `rclone copy
    versions/<timestamp>-<mmm>-<run>/<path> <target>`.
- O app lista versões, datas e arquivos via `ListVersions`/`ListBackup` e
  oferece um navegador de backup. O dry-run é padrão.
- Trocar o destino de um job Sync começa um novo espelho; arquivos do destino
  antigo não são movidos.

## 11. Volumes removíveis

`src/volumes.js`:

- Enumera `Gio.VolumeMonitor`.
- Para cada volume: UUID (`get_identifier('uuid')`), mount root, activation.
- Ao cadastrar uma pasta local, o app encontra o mount que contém o caminho e
  guarda `volumeUuid` + `relativePath`.
- Na execução, resolve UUID → mount atual. Se não houver, status
  `waiting-source`/`waiting-destination` e retry no `mount-added`.
- Escuta `mount-added`, `mount-removed`, `drive-disconnected`.
- Se a origem sumir durante uma execução, o runner é cancelado e o job pausa;
  nenhuma deleção em massa é propagada.

## 12. Agendamento, rede e energia

- `application/scheduler.js` usa o port `Clock`; o adapter `SystemClock` usa
  timers GLib. O scheduler é testável com clock fake.
- `RetryPolicy` puro: 1 min, 5 min, 15 min, 1 h (máximo).
- `JobStateMachine` puro decide `idle`, `paused`, `waiting-source` e
  `disabled`.
- Ao iniciar, jobs `realtime`/`interval` atrasados rodam imediatamente.
- `logind` (`PrepareForSleep`) dispara reconciliação no resume.
- `Gio.NetworkMonitor` pausa jobs de nuvem quando offline e retoma ao voltar.
- Limite de jobs simultâneos (padrão 1) para não saturar disco/rede.
- `--bwlimit` por job.

## 13. Segurança

- Daemon e app rodam como o usuário; nunca root.
- D-Bus só na sessão; sem listener de rede.
- Config, tokens e logs com `0600`; diretórios `0700`.
- Nenhum segredo em log.
- Argumentos de rclone são array; sem interpolação de shell.
- Validação de overlap origem/destino e de remotes.
- Filtros padrão excluem lixeira e arquivos de sistema.
- OAuth usa o cliente do rclone; tokens ficam no rclone.conf do SaveMe.
- Symlinks não são seguidos por padrão; opção explícita.

## 14. Testes

- Unitários (GJS): config, validação de job, overlap, paths, volumes (mocks),
  fila/debounce, parser de JSON do rclone, montagem de argv, retenção,
  classificação de exit codes.
- Application: SyncService/BackupService/RestoreService com fakes de transfer,
  filesystem, state, clock e paths; cobre full/incremental, dry-run, delete
  guard, cancelamento, retenção e restore.
- Daemon: DaemonService com fakes de config/state/manager/auth/transfer;
  DaemonApi fino testado por contrato.
- Supervisor: Scheduler com clock fake, RetryPolicy e JobStateMachine puros.
- Adapters: filesystem Gio, raw log, clock, paths e run repository.
- Integração com rclone local em diretórios temporários:
  - sync inicial, upsert, rename, delete;
  - backup com versões e retenção;
  - dry-run com contagens;
  - guarda de deleção;
  - origem ausente/vazia;
  - restore atual e de versão.
- D-Bus: daemon em `dbus-run-session`, chamadas reais, sinais e persistência.
- Watcher: criação/alteração/rename/delete reais com `Gio.FileMonitor`,
  incluindo escrita atômica e temp files.
- App: gateways e formatação pura em unitários; `make e2e-app` sobe daemon +
  GNOME Shell headless, abre a janela real com `--smoke-test`, percorre todas
  as views e encerra com código de saída.
- Extensão: gateways e view model puros em unitários; teste manual no GNOME 50
  e `make e2e-extension` headless.
- Lint: `make lint` roda pre-commit em todos os arquivos, com ESLint (GJS),
  Stylelint (GTK/St), ShellCheck, Ruff, Vulture, Knip, Markdownlint,
  `desktop-file-validate` e as regras de arquitetura do Omega.
  Ver [LINTING.md](LINTING.md).
- CI: Ubuntu 26.04, rclone pinado, `make lint`, `make test`, `make coverage`,
  `make e2e`, `make e2e-app`, build do zip e do `.deb`.
- Matriz manual antes do release: instalação limpa, três provedores, disco
  removível, offline, suspend/resume, reboot, restore.

## 15. Empacotamento e publicação

- `make test`, `make dist`, `make deb`, `make extension`.
- `make deb` gera `dist/saveme_<versão>_<arch>.deb` com daemon, app, CLI,
  rclone pinado, systemd, D-Bus, autostart, ícone e licenças.
- `make extension` gera o zip do EGO em `dist/`.
- `scripts/install.sh` instala/sobrescreve via apt, para o daemon, reinstala a
  extensão e reinicia o daemon. `--dry-run` mostra o plano.
- `scripts/uninstall.sh` remove daemon, extensão, pacote e, com `--purge`,
  configuração/tokens/logs.
- `dist/saveme_<arch>.deb` e `SHA256SUMS` são os nomes estáveis usados pelo
  instalador `curl | sh` nos releases do GitHub.
- `.deb`:
  - `/usr/bin/saveme`, `saveme-daemon`, `saveme-settings`
  - `/usr/lib/saveme/` (código GJS + rclone pinado)
  - `/usr/lib/systemd/user/saveme.service`
  - `/usr/share/dbus-1/services/io.github.chrismaille.SaveMe.Daemon.service`
  - `/usr/share/applications/io.github.chrismaille.SaveMe.Settings.desktop`
  - `/usr/share/icons/hicolor/scalable/apps/...`
  - `/usr/share/locale/...`
  - `/usr/share/doc/saveme/` (licenças, incluindo a do rclone)
- Extensão: `gnome-extensions pack` → zip para o EGO.
- O `.deb` instala o daemon/app; a extensão é instalada pelo EGO ou pelo botão
  “Instalar extensão” do app (a partir do zip embarcado), nunca nas duas
  origens ao mesmo tempo.
- Releases no GitHub com `.deb` (amd64/arm64) e zip da extensão.
- Sem Flatpak/Snap para o daemon nesta fase: sandbox atrapalha acesso a discos
  arbitrários e mounts removíveis.
- AppImage fica adiado. Flatpak é o formato preferido para uma eventual versão
  futura do **app** (não do daemon/extensão), mas só depois que o `.deb` da
  v1.0 estiver estável. O daemon precisa de systemd, D-Bus e acesso amplo ao
  filesystem; isso continua nativo por enquanto.

## 16. ADRs resumidos

- **ADR-001** — GJS para daemon, app e extensão: runtime nativo, uma linguagem,
  integração direta com GLib/Gio/GTK.
- **ADR-002** — Daemon separado da extensão: confiabilidade e isolamento do
  Shell.
- **ADR-003** — rclone como motor: não reimplementar nuvem.
- **ADR-004** — Somente mão única, com modos Sync e Backup: o nome e o escopo
  do produto.
- **ADR-005** — Tempo real via `Gio.FileMonitor` recursivo, com polling de
  fallback e reconciliação periódica.
- **ADR-006** — Versões via `--backup-dir` ao lado do destino: simples,
  eficiente e restaurável.
- **ADR-007** — rclone pinado no `.deb`: o pacote do Ubuntu 26.04 é 1.60.1;
  o app exige comportamento atual e reproduzível.
- **ADR-008** — iCloud fora de escopo: API instável/experimental.
- **ADR-009** — Distribuição: GitHub Releases + `.deb` + EGO; sem Flatpak/Snap
  para o daemon.
- **ADR-010** — AppImage adiado; Flatpak é o preferido para o app no futuro.
  A v1.0 sai como `.deb` com rclone pinado. A extensão continua separada no
  EGO; o daemon continua nativo por causa de systemd/D-Bus/filesystem.
