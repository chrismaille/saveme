<p align="center">
  <img src="assets/icon.png" width="128" alt="Ícone do SaveMe">
</p>

<h1 align="center">SaveMe</h1>

<p align="center"><strong>Sincronização unidirecional e backup com versões para o GNOME.</strong></p>

<p align="center">
  <a href="https://github.com/chrismaille/saveme/actions/workflows/ci.yml"><img src="https://github.com/chrismaille/saveme/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/chrismaille/saveme/actions/workflows/release.yml"><img src="https://github.com/chrismaille/saveme/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg" alt="GPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/GNOME-50-4a86cf.svg" alt="GNOME 50">
</p>

<p align="center"><a href="README.md">English</a></p>

O SaveMe é um aplicativo GTK4/libadwaita com um pequeno daemon de usuário que
mantém uma pasta sincronizada com um disco local ou destino na nuvem, ou cria
um backup com versões dessa pasta. Foi feito para o GNOME no Linux e se integra
ao Shell por meio de uma extensão opcional.

> **Estado do projeto:** pré-release. O aplicativo, daemon, CLI, extensão do
> GNOME, fluxo de recuperação e provedores de nuvem estão implementados. A
> validação com contas reais de todos os provedores ainda está em andamento.

## Por que usar

- **Dois modos claros.** Sincronização espelha as mudanças imediatamente.
  Backup guarda versões dos arquivos substituídos ou excluídos.
- **Destinos locais e na nuvem.** Use um disco externo, OneDrive, Google Drive,
  Dropbox, Nextcloud/WebDAV, armazenamento compatível com S3 ou pCloud.
- **Compartilha o destino com segurança.** Cada job usa `SaveMe/<job-id>` dentro
  de uma pasta base SaveMe, então vários jobs podem usar a mesma conta sem
  sobrescrever uns aos outros.
- **Proteções integradas.** A proteção contra exclusão interrompe uma execução
  antes de remover arquivos demais. Pastas vazias ou recriadas são detectadas
  antes de acessar a nuvem.
- **Recuperação de verdade.** Navegue por uma pasta SaveMe, importe jobs e
  restaure arquivos para outra pasta local.
- **Integração nativa.** Autostart, serviço `systemd --user`, D-Bus,
  notificações de backup e extensão opcional do GNOME Shell.
- **Traduzido.** O aplicativo, o daemon e a extensão têm 16 idiomas.

## Funcionalidades

### Sincronização

A sincronização espelha o conteúdo selecionado da origem no destino. Criações,
alterações, renomeações e exclusões são propagadas. Jobs de sincronização não
guardam versões. Uma pasta base pode ser compartilhada por vários jobs porque
cada um recebe sua própria pasta `SaveMe/<job-id>`.

### Backup

O backup copia as mudanças para o destino e move arquivos substituídos ou
excluídos para uma pasta de versões. A retenção pode manter versões por alguns
dias ou para sempre. Um job de backup pode combinar várias origens. O modo em
tempo real não está disponível para backups por decisão de projeto.

### Restauração e recuperação

Abra uma pasta SaveMe existente, inspecione os manifestos, importe jobs e
restaure uma versão para uma pasta local. Jobs importados ficam desativados e
em modo manual até você revisar as origens e o destino.

### Agendamento e controle

- Tempo real, intervalo, semanal, mensal, ao anoitecer, na inicialização e
  manual.
- "Ao anoitecer" segue automaticamente o agendamento de luz noturna do GNOME.
- Execuções podem esperar o computador ficar ocioso.
- Controles de iniciar, pausar e parar por job. Parar também pausa a recorrência
  até você pressionar Iniciar.
- Backups interrompidos são retomados uma vez quando o daemon inicia.
- A quantidade de jobs simultâneos é configurável; o padrão é 2.
- Execuções perdidas enquanto o computador estava desligado são recuperadas.

### Segurança

- Proteção contra exclusão configurável por job, direto nos detalhes do job.
- Proteção contra origem vazia e contra mudanças bruscas na origem.
- Verificação dos volumes de origem e destino antes de uma execução.
- Verificação de espaço livre local e de cota remota.
- Credenciais são sanitizadas antes de serem gravadas ou exibidas nos logs.
- Rotação de logs por idade e tamanho.

## Serviços suportados

**Origens e destinos:**

- Pastas locais e unidades removíveis (resolvidas por UUID do volume)
- Google Drive
- Microsoft OneDrive (pessoal e empresarial)
- Dropbox
- Nextcloud e outros servidores WebDAV
- Armazenamento compatível com S3
- pCloud

O iCloud está fora do escopo até a Apple oferecer uma API estável.

## Instalação

### Requisitos

- Ubuntu 26.04 ou distribuição compatível com GNOME 50
- GJS 1.88+, GTK 4.22+, libadwaita 1.9+
- rclone 1.60+ (o instalador inclui um binário fixado 1.76; o pacote PPA
  usa o rclone da distribuição)

### Recomendado: PPA (Launchpad)

O PPA é a instalação preferida porque o Ubuntu atualiza o SaveMe junto com o
sistema. O primeiro build está sendo processado pelo Launchpad; se o pacote
ainda não estiver disponível, use o script de instalação abaixo.

```bash
sudo add-apt-repository ppa:chrismaille/saveme
sudo apt update
sudo apt install saveme
```

Depois disso:

```bash
sudo apt upgrade
```

O pacote do PPA instala o aplicativo, daemon, serviço D-Bus, CLI e o zip da
extensão. A extensão opcional do GNOME pode ser instalada e ativada uma vez
com:

```bash
gnome-extensions install --force /usr/share/saveme/extension.zip
gnome-extensions enable saveme@chrismaille.github.io
```

Detalhes de build e envio: [docs/PPA.md](docs/PPA.md).

### Alternativa: script de instalação

O script é um bootstrap para o `.deb` das releases do GitHub. Ele serve para a
primeira instalação, para testar um build local ou quando o pacote do PPA
ainda não está disponível. Ele não é específico desta máquina: usa apenas o
usuário atual, a arquitetura do host e os caminhos padrão da sessão.

O que o script faz antes de instalar:

1. resolve o pacote:
   - `--deb PATH`, se informado;
   - um `dist/saveme_<arch>.deb` local, quando rodado de um checkout;
   - senão, a release mais recente do GitHub (ou `--version X.Y.Z`).
2. baixa o zip da extensão e verifica o `SHA256SUMS` quando disponível.
3. para o aplicativo e o daemon `systemd --user` em execução.
4. chama `sudo` somente para o `apt-get install --reinstall` do `.deb`.
5. instala/atualiza a extensão do GNOME por padrão
   (`--no-extension`/`--app-only` pula).
6. ativa e inicia o daemon do usuário.
7. roda `saveme doctor` e grava o log em
   `~/.local/state/saveme-install.log`.

Ele **não** apaga jobs, configuração, contas ou histórico. Use
`--uninstall --purge --yes` somente quando quiser remover esses dados.

```bash
curl -fsSL https://raw.githubusercontent.com/chrismaille/saveme/main/scripts/install.sh | sh
```

Opções úteis:

```bash
./scripts/install.sh --no-extension   # somente app + daemon
./scripts/install.sh --app-only       # apelido para --no-extension
./scripts/install.sh --dry-run        # mostra o plano sem alterar nada
./scripts/install.sh --remote         # força a release mesmo com dist/
./scripts/install.sh --uninstall      # remove o pacote, mantém os dados
```

### A partir de um checkout local

```bash
make test
make deb
./scripts/install.sh
```

Instruções completas: [docs/INSTALL.md](docs/INSTALL.md).

### Primeira execução

1. Abra o **SaveMe** pelo menu de aplicativos.
2. Crie um job e escolha **Sincronização** ou **Backup**.
3. Selecione a origem e uma pasta base SaveMe.
4. Adicione uma conta na nuvem, se necessário.
5. Revise o agendamento e as opções de segurança e salve.
6. Use o botão Iniciar para rodar agora, ou deixe o agendamento executar.

A extensão do GNOME mostra o status dos jobs e oferece Iniciar/Pausar/Parar no
painel superior. Ela é opcional; o aplicativo e o daemon funcionam sem ela.

## Arquitetura

```text
Extensão do GNOME Shell (GJS, opcional) ──D-Bus──┐
                                                  ├── saveme-daemon (GJS,
SaveMe Settings (GTK4/Adwaita) ───────────────────┤    systemd --user) ── rclone
                                                  │                         │
CLI (saveme) ─────────────────────────────────────┘                         └── local / nuvem
```

O daemon controla configuração, estado, agendamento, watchers, logs e o ciclo
de vida das transferências. O aplicativo GTK conversa com ele por D-Bus. A
extensão é uma interface fina e nunca guarda o estado dos jobs.

Veja [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) para o desenho técnico.

## Desenvolvimento

```bash
make setup          # baixa o rclone fixado para desenvolvimento
make setup-hooks    # instala os hooks pre-commit + commit-msg
make lint           # pre-commit em todos os arquivos
make test           # testes unitários + integração
make tests          # unitários + E2E do daemon + extensão/app
make e2e-app        # smoke do app GTK + soak de memória
make verify         # lint + testes
make doctor         # verifica rclone, caminhos e volumes
make run ARGS="status"
make extension      # gera o zip da extensão
make deb            # gera o .deb
```

Requisitos de desenvolvimento: Python 3.11+, Node.js 22+ e
`desktop-file-utils` para o lint; GNOME Shell 50 para o E2E da extensão.

## Releases

O versionamento é automático: os commits seguem
[Conventional Commits](https://www.conventionalcommits.org/), e o
[semantic-release](https://semantic-release.gitbook.io/) cria a tag, o
changelog e a release no GitHub a cada push na `main`.

Veja [docs/RELEASING.md](docs/RELEASING.md).

## Distribuição

O caminho de instalação suportado hoje é o pacote `.deb` instalado pelo script,
com um PPA do Launchpad para atualizações automáticas. AppImage não combina com
o daemon, D-Bus, serviço `systemd --user` e extensão do GNOME. Snap e Flatpak
estão em avaliação antes de qualquer envio para lojas.

Veja [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) para a comparação.

## Documentação

- [docs/SPEC.md](docs/SPEC.md) — escopo e critérios de aceitação
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — decisões técnicas
- [docs/INSTALL.md](docs/INSTALL.md) — instalação, CLI e desinstalação
- [docs/UBUNTU.md](docs/UBUNTU.md) — PPA e arquivo oficial do Ubuntu
- [docs/PPA.md](docs/PPA.md) — build e envio para o PPA do Launchpad
- [docs/TESTING.md](docs/TESTING.md) — matriz de testes automáticos e manuais
- [docs/LINTING.md](docs/LINTING.md) — pre-commit, linters e regras Omega
- [docs/RELEASING.md](docs/RELEASING.md) — commits e releases automáticas
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) — AppImage, Snap e Flatpak

## Licença

GPL-3.0-or-later. Veja [LICENSE](LICENSE). O binário do rclone incluído é MIT;
veja `data/rclone-LICENSE`.
