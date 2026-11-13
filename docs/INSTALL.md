# Instalação

## Requisitos

- Ubuntu 26.04 (GNOME 50)
- Sessão Wayland ou X11
- O `.deb` já inclui o rclone 1.76 pinado em `/usr/lib/saveme/bin/rclone`

## 1. Construir o pacote

```bash
make test
make deb
```

Os artefatos ficam em `dist/`:

- `saveme_<versão>_<arch>.deb`
- `saveme@chrismaille.github.io.shell-extension.zip`

## 2. Instalar o daemon e o app

```bash
sudo apt install ./dist/saveme_*.deb
```

O pacote instala:

- `/usr/bin/saveme` — CLI
- `/usr/bin/saveme-daemon` — daemon
- `/usr/bin/saveme-settings` — app GTK4/Adwaita
- `/usr/lib/saveme/` — código e rclone
- autostart em `/etc/xdg/autostart/saveme-daemon.desktop`
- unidade systemd de usuário `saveme.service`
- serviço D-Bus `io.github.chrismaille.SaveMe.Daemon`
- zip da extensão em `/usr/share/saveme/extension.zip`

## 3. Instalar a extensão GNOME

A extensão é distribuída separadamente para evitar conflito com o
extensions.gnome.org.

Opção A — extensions.gnome.org:

1. Abra a página da extensão no EGO.
2. Instale e habilite.

Opção B — zip local:

```bash
gnome-extensions install --force /usr/share/saveme/extension.zip
gnome-extensions enable saveme@chrismaille.github.io
```

Em Wayland, se a extensão não aparecer imediatamente, faça logout/login.

## 4. Iniciar o daemon

O daemon inicia automaticamente no próximo login. Para iniciar agora:

```bash
saveme-daemon &
```

Ou, se preferir systemd de usuário:

```bash
systemctl --user enable --now saveme.service
```

## 5. Configurar

```bash
saveme-settings
```

Fluxo recomendado:

1. **Accounts** → adicionar Google Drive, OneDrive ou Dropbox.
2. **Jobs** → **New job**.
3. Escolher origem e destino.
4. Escolher **Sync** (espelho em tempo real) ou **Backup** (com versões).
5. Usar **Save & Dry Run** no primeiro job e conferir o resultado em **Logs**.
6. Quando estiver correto, usar **Run now**.

A aba **Debug** do app mostra o log do daemon, o resultado do Doctor, os
caminhos de configuração/estado e um botão **Copy diagnostics** para relatar
problemas. Também é possível abrir direto:

```bash
saveme-settings --view debug
```


## CLI

```bash
saveme doctor
saveme status
saveme job list
saveme job add --name "Docs" --type sync \
  --source ~/Documentos --dest gdrive:SaveMe/Documentos
saveme run <job-id> --dry-run
saveme run <job-id>
```

## Desinstalar

Ordem recomendada:

```bash
# 1. Para o daemon, remove a extensão e, opcionalmente, os dados do usuário
saveme uninstall --purge --yes

# 2. Remove o pacote do sistema
sudo apt remove saveme
```

O que cada etapa remove:

- `saveme uninstall --yes`: para o daemon, desabilita `saveme.service` e remove
  a extensão GNOME. Configuração, tokens e logs são mantidos.
- `saveme uninstall --purge --yes`: faz o acima e remove também:
  - `~/.config/saveme/` (configuração e `rclone.conf` com tokens OAuth)
  - `~/.local/state/saveme/` (estado, logs e histórico)
  - `~/.cache/saveme/`
  - `$XDG_RUNTIME_DIR/saveme/`
- `sudo apt remove saveme`: remove binários, rclone bundled, systemd, D-Bus,
  autostart, ícones e documentação do sistema.

`apt purge` não remove dados do usuário; use `saveme uninstall --purge --yes`
antes. Se a extensão tiver sido instalada pelo extensions.gnome.org e o comando
não conseguir removê-la, remova pelo app **Extensões** do GNOME.


## Solução de problemas

```bash
saveme doctor
```

Logs:

- Daemon: `~/.local/state/saveme/daemon.log`
- Execuções: `~/.local/state/saveme/logs/<job-id>/`
- Journal: `journalctl --user -b | grep -i saveme`
