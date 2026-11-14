# SaveMe — Especificação da v1.0

Status: escopo fechado, em implementação.
Este documento é a fonte da verdade do que significa “MVP 100% funcional”.
Não há entregas parciais: a v1.0 só é considerada pronta quando todos os
critérios de aceitação abaixo passarem.

## 1. Princípio do produto

SaveMe é **de mão única**: `Origem → Destino`. O nome do app é a direção.

Existem dois tipos de job:

### Sync

- O destino é um espelho da origem.
- Criação, alteração, renomeação e remoção propagam em tempo real.
- Não guarda versões anteriores.
- Deleções são protegidas por limite de segurança e confirmação.

### Backup

- O destino recebe cópias atualizadas da origem.
- Toda versão anterior de um arquivo sobrescrito é preservada.
- Remoções na origem **não** removem o destino.
- Versões antigas podem ser restauradas pela interface.
- Retenção configurável (padrão: 30 dias; `0` = manter para sempre).

Os dois modos compartilham o mesmo motor, o mesmo watcher e o mesmo modelo de
status. A diferença está na política de deleção e versionamento.

## 2. Fora de escopo na v1.0

- iCloud (Drive ou Photos).
- Sync de duas vias / resolução de conflitos.
- Windows, macOS, Android ou iOS.
- Compartilhamento, colaboração ou edição de arquivos.
- Criptografia client-side.
- Backup de sistema inteiro, imagens de disco ou bancos de dados em uso.
- Web UI.
- Múltiplos usuários ou execução como root.
- Tempo real quando a origem é um remote de nuvem (usa polling).

## 3. Origens e destinos

Suportados:

- Pasta local em disco interno.
- Pasta local em disco removível, identificada por UUID do volume.
- Remote rclone: Google Drive, OneDrive (pessoal/business), Dropbox.

Combinações:

- local → local
- local → nuvem
- nuvem → local
- nuvem → nuvem

Tempo real só é possível quando a origem é local. Para origem na nuvem, o job
usa polling a cada 5 minutos (configurável) e reconciliação completa periódica.

## 4. Modelo de job

```json
{
  "id": "job_01",
  "name": "Documentos → Google Drive",
  "type": "sync",
  "enabled": true,
  "source": {
    "kind": "local",
    "path": "/home/user/Documentos",
    "volumeUuid": "6e192d2d-0de8-4939-b7d7-a8976c7e5448",
    "relativePath": "Documentos"
  },
  "sources": [
    {
      "kind": "local",
      "path": "/home/user/Documentos"
    }
  ],
  "destination": {
    "kind": "remote",
    "remote": "gdrive-pessoal",
    "path": "SaveMe/Documentos"
  },
  "trigger": {
    "mode": "realtime"
  },
  "filters": {
    "exclude": []
  },
  "options": {
    "maxDeletePercent": 10,
    "maxDeleteMinimum": 10,
    "bandwidthLimit": "",
    "transfers": 4,
    "checkers": 8,
    "preserveMetadata": false,
    "followSymlinks": false,
    "notifyOnComplete": true
  },
  "backup": {
    "retentionDays": 30
  }
}
```

Regras:

- `type` é `sync` ou `backup`.
- `trigger.mode` é `realtime`, `interval` ou `manual`.
- `source` e `destination` nunca podem ser iguais, nem um dentro do outro.
- Dois jobs não podem escrever no mesmo destino ao mesmo tempo.
- Filtros de exclusão usam a sintaxe de filtros do rclone.
- Exclusões padrão: `.saveme/**`, `.saveme-versions/**`, `.Trash-*/**`,
  `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.tmp`, `*.partial`.
- O job guarda `confirmedAt` depois que o usuário viu o dry-run inicial.

## 5. Tempo real

- Watcher recursivo com `Gio.FileMonitor` (inotify) sobre a origem local.
- Eventos relevantes: `CHANGES_DONE_HINT`, `CREATED`, `DELETED`, `RENAMED`,
  `MOVED_IN`, `MOVED_OUT`, `ATTRIBUTE_CHANGED`.
- Debounce de 1 s; lotes de até 2 s; coalescência por caminho.
- Arquivos temporários de escrita atômica são ignorados; o evento final
  `RENAMED` é usado.
- Se o lote passar de 500 mudanças, o job faz reconciliação completa em vez de
  operações por arquivo.
- Se o watcher não puder ser usado (limite de inotify, origem na nuvem),
  fallback para polling a cada 5 minutos.
- Mesmo em tempo real, há reconciliação completa a cada 24 horas para corrigir
  eventos perdidos.
- Alterações durante uma execução ficam em fila e são aplicadas na execução
  seguinte.

## 6. Segurança contra perda de dados

- Primeiro run de um job novo é sempre dry-run com resumo:
  “X arquivos novos, Y atualizados, Z removidos, N bytes”.
- Sync com destino não vazio exige confirmação explícita.
- `maxDeletePercent` (padrão 10%): o job aborta se uma execução remover mais
  que isso. O usuário pode forçar depois de ver o resumo.
- `maxDeleteMinimum` (padrão 10): permite um número absoluto pequeno de
  exclusões antes de aplicar o percentual, para não bloquear renomes em
  árvores pequenas.
- Antes de um sync completo, o daemon executa um dry-run interno para contar
  as exclusões e abortar antes de tocar no destino.
- Se a origem desaparecer (disco removido, mount perdido), o job pausa. Nunca
  propaga uma deleção em massa causada por origem ausente.
- Se a origem estiver vazia e antes tinha arquivos, o job aborta.
- Deleções incrementais também passam pelo limite percentual.
- Cancelamento é gracioso: SIGINT no rclone, estado consistente.
- Configuração e logs com permissão `0600`; daemon roda como usuário.
- Logs têm rotação por tamanho, retenção por idade/tamanho e sanitização de
  credenciais antes de escrever, exibir ou copiar diagnósticos.
- Sync/backup para destino local verificam espaço livre com margem antes de
  iniciar; o job para como `no-space` se não houver espaço.
- Para destino remoto, a checagem usa a cota reportada por `rclone about`
  quando disponível.
- O browser remoto limita pastas com muitas entradas para não carregar listas
  gigantes na memória.
- Nenhum argumento de shell é montado por concatenação; subprocessos usam argv.

## 7. Backup e restauração

Layout no destino:

```
<destino>/SaveMe/<job-id>/current/<caminho-relativo>
<destino>/SaveMe/<job-id>/versions/<timestamp>-<mmm>-<run>/<caminho-relativo>
```

O destino escolhido é a pasta-base; o app cria `SaveMe` dentro dela e recusa o
job se essa pasta já existir. Cada job grava `manifest.json` para recuperação.
Com múltiplas origens, `current` e `versions` têm uma subpasta por origem
(nomes duplicados recebem sufixo).

Para remote:

```
<remote>:<destino>/SaveMe/<job-id>/current/...
<remote>:<destino>/SaveMe/<job-id>/versions/<timestamp>-<mmm>-<run>/...
```

- `current` é o espelho do último backup.
- `versions/<timestamp>-<mmm>-<run>` contém os arquivos sobrescritos ou removidos naquele
  lote. Não é um snapshot completo; é o histórico incremental.
- Cada execução com mudanças gera um diretório de versão com timestamp.
- A limpeza de retenção remove diretórios de versão antigos.
- A interface permite:
  - restaurar o backup atual inteiro;
  - navegar no backup atual ou em uma versão por data;
  - restaurar um arquivo ou pasta específico;
  - fazer dry-run antes de restaurar.
- Restauração nunca sobrescreve sem confirmação.

O destino configurado no job de backup é a **pasta base**. O SaveMe cria
`SaveMe/<job-id>/` dentro dela.

## 7.1 Sync

No modo Sync, o destino configurado é o espelho direto da origem. Alterações
na origem são refletidas no destino. Trocar a pasta de destino pela edição do
job começa um novo espelho; os arquivos do destino antigo não são movidos.

## 8. Discos removíveis

- O job guarda UUID do volume + caminho relativo.
- Em tempo de execução, o UUID é resolvido para o mount atual via
  `Gio.VolumeMonitor`.
- `mount-added` e `mount-removed` são observados.
- Origem ausente: status `waiting-source`; destino ausente:
  `waiting-destination`. Sem spam de erro; retry quando o volume voltar.
- Se o disco sumir no meio de uma execução, o job é cancelado e o destino não
  sofre a deleção em massa.
- Discos internos montados permanentemente também podem ser cadastrados por
  UUID; o caminho é estável.

## 9. Superfícies de UI

### Extensão GNOME

- Ícone no painel com indicador de estado (idle, rodando, erro, pausado).
- Popup com lista de jobs: nome, tipo, status, último resultado, progresso.
- Ações por job: executar agora, pausar/retomar, cancelar.
- Ações globais: pausar tudo, abrir configurações, abrir logs.
- Não edita jobs; isso é responsabilidade do app.
- Se o daemon não estiver disponível, mostra estado explicativo e botão para
  abrir as configurações.

### SaveMe Settings (GTK4/Adwaita)

- Lista e editor de jobs.
- Cadastro de contas/remotes com fluxo OAuth.
- Dry-run e resumo antes de salvar/ativar.
- Logs por job e por execução.
- Gestão de logs: uso em disco, retenção, limpeza, sanitização e log do app.
- Performance: RSS, pico, CPU do app/daemon e CPU/memória da máquina.
- Backup com múltiplas origens locais e notificação de conclusão por job.
- Recuperação: indicar uma pasta `SaveMe`, importar o job pelo manifesto e
  restaurar para uma pasta local diferente da original.
- Preferências: notificações, iniciar com a sessão, limites, idioma.
- Diagnóstico (“Doctor”): rclone, daemon, inotify, keyring, mounts.

### CLI

- `saveme status`
- `saveme job list`
- `saveme job run <id> [--dry-run]`
- `saveme job cancel <id>`
- `saveme logs <id> [run]`
- `saveme remote list`
- `saveme restore ...`
- `saveme doctor`

A CLI usa a mesma API D-Bus do daemon.

## 10. Daemon e operação

- Serviço `systemd --user` com ativação por D-Bus.
- Sobrevive ao fechamento da UI e a reinícios do GNOME Shell.
- Inicia com a sessão (configurável) e reconcilia jobs atrasados.
- Detecta suspend/resume e executa jobs vencidos ao voltar.
- Detecta rede indisponível e faz backoff exponencial.
- Limite de jobs simultâneos (padrão 1).
- Estado persistido em JSON; escrita atômica.
- Logs por execução, com resumo e log bruto do rclone.
- Rotação por tamanho, retenção padrão de 30 dias/50 MiB, limpeza automática a
  cada 6 h e sanitização de segredos.
- O app mede o próprio RSS/pico/CPU, registra amostras e avisa quando o
  orçamento é excedido; o daemon faz o mesmo no log e no snapshot.
- Sync para destino local com pouco espaço livre aborta como `no-space` antes
  de escrever.
- Notificações apenas em transições relevantes: erro, origem/destino ausente,
  reautenticação necessária e resumo opcional de conclusão.

## 11. Nuvem e autenticação

- Configuração própria do SaveMe em `~/.config/saveme/rclone.conf` (`0600`).
- Nunca altera o `~/.config/rclone/rclone.conf` do usuário.
- OAuth via `rclone authorize <backend> --auth-no-open-browser`:
  - o app mostra a URL e abre o navegador;
  - o daemon lê o token do stdout;
  - cria o remote com `rclone config create`.
- Reautenticação guiada quando o token expirar ou for revogado.
- Teste de conexão por remote.
- Múltiplas contas do mesmo provedor são suportadas com nomes únicos.

## 12. Publicação

- Licença GPL-3.0-or-later.
- Código no GitHub, com README, docs, CI e releases.
- Extensão publicada no extensions.gnome.org.
- Pacote `.deb` com daemon, app, CLI, unidade systemd, traduções e um rclone
  pinado (o rclone do Ubuntu 26.04 é 1.60.1; o atual é 1.76.0).
- A extensão do EGO é só UI; o `.deb` entrega o daemon/app.
- Idiomas: inglês (fonte) e português do Brasil.
- Versão inicial: 1.0.0.

## 13. Critérios de aceitação

A v1.0 só é considerada pronta quando todos estes cenários passarem em uma
instalação limpa do Ubuntu 26.04:

1. Instalar o `.deb`; daemon inicia; app abre; extensão instala e habilita.
2. Adicionar Google Drive, OneDrive e Dropbox via OAuth; testar conexão;
   reautenticar um remote expirado.
3. Criar job Sync local → local; criar, editar, renomear e apagar arquivos;
   o destino reflete tudo em menos de 5 segundos, sem arquivos temporários.
4. Criar job Sync local → nuvem; mesmo comportamento, com progresso visível.
5. Apagar mais de 10% dos arquivos de uma vez; o job pausa, notifica e não
   altera o destino; o modo “forçar” funciona após confirmação.
6. Desconectar o disco de origem; o job pausa sem apagar nada no destino;
   reconectar; o job reconcilia e volta ao tempo real.
7. Criar job Backup; alterar o mesmo arquivo 3 vezes; existem 3 versões;
   restaurar cada uma; a retenção remove versões além do prazo.
8. Apagar um arquivo na origem de um job Backup; o destino mantém a última
   cópia e as versões.
9. Ficar offline com destino na nuvem; o job tenta com backoff; ao voltar a
   rede, recupera o atraso sem duplicar dados.
10. Reiniciar a máquina e suspender/retomar; estado, agendamentos e jobs
    atrasados funcionam.
11. O popup da extensão mostra status e progresso corretos; executar, pausar e
    cancelar funcionam; configurações e logs abrem.
12. Logs mostram resumo por execução, erros por arquivo e log bruto; nada de
    log infinito sem rotação. O app mostra uso, limpa, sanitiza e aplica a
    política de retenção.
13. O primeiro run mostra dry-run com contagens corretas e exige confirmação.
14. Desinstalar o `.deb` remove binários, serviços, logs, caches e temporários;
    configuração/estado só são removidos com `--purge`. Rodar o instalador
    novamente atualiza preservando configuração, jobs, estado e histórico.
15. `make test` e o CI passam; documentação de instalação, uso e restore está
    publicada; pt-BR e en funcionam.
16. O app mantém o uso de memória sob o orçamento no soak E2E e registra
    amostras de RSS/CPU no próprio log; o daemon também registra RSS/CPU.
17. Sync da raiz do Google Drive para destino local com espaço insuficiente
    para como `no-space` sem escrever arquivos; o browser recusa listagens
    acima do limite e orienta abrir uma subpasta.
18. Criar backup com duas pastas locais e destino OneDrive; o app cria
    `SaveMe/<job-id>` e o layout por origem; o job roda a cada hora.
19. Durante o backup, o app mostra arquivo, velocidade, ETA, CPU e memória da
    máquina; ao concluir, notifica se a opção do job estiver ligada.
20. Em uma instalação nova, indicar a pasta `SaveMe`, importar o manifesto,
    escolher o backup e restaurar para outra pasta local.

## 14. Riscos conhecidos

- Limite de watches do inotify em árvores muito grandes; mitigado com fallback
  para polling e aviso no Doctor.
- Provedores mudam APIs; o rclone pinado reduz surpresas, mas atualizações
  periódicas são necessárias.
- OAuth depende de navegador e das políticas de cada provedor.
- Regressões de memória em GJS/GTK são vigiadas por amostras no app log e pelo
  soak E2E; os limites podem ser ajustados por
  `SAVEME_SOAK_MAX_RSS_DELTA_MB` e `SAVEME_SOAK_MAX_RSS_MB`.
- Arquivos abertos/DBs podem ser copiados em estado inconsistente; o app deve
  documentar que não substitui snapshot/dump de aplicação.
- Real-time em nuvem sofre rate limit; debounce e batching são obrigatórios.
