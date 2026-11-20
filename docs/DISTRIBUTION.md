# Distribuição: AppImage, Snap e Flatpak

Este documento compara as opções antes de definir o empacotamento do
SaveMe. Nenhuma dessas opções está implementada no workflow de release.

## O que o SaveMe precisa instalar

O produto não é apenas uma janela GTK. Ele depende de:

- aplicativo GTK4/Adwaita;
- daemon D-Bus de sessão;
- serviço `systemd --user`;
- autostart do daemon no login;
- extensão do GNOME Shell;
- binário `rclone` e configuração OAuth;
- acesso a pastas locais, unidades removíveis e serviços de nuvem.

Qualquer formato precisa resolver esses pontos sem quebrar a experiência.

## AppImage

Um AppImage é um executável único, sem instalação. Ele funciona bem para
aplicativos gráficos autocontidos.

Para o SaveMe, não é uma boa opção:

- não instala o serviço D-Bus, o `systemd --user` nem o autostart;
- não instala a extensão do GNOME Shell;
- integração com montagem de discos e com o ambiente do usuário fica
  limitada ao processo iniciado pelo AppImage;
- atualizações e integração com o menu do GNOME exigem trabalho extra;
- o daemon precisaria ser iniciado pelo próprio AppImage, sem o ciclo de
  vida normal de um serviço de sessão.

Resumo: AppImage não cobre a arquitetura atual do SaveMe.

## Flatpak

Flatpak é sandboxed, tem boa integração com o desktop e é o formato aceito
pelo Flathub.

Pontos positivos:

- distribuição e atualização pelo Flathub;
- bom suporte a GTK4/Adwaita;
- permissões explícitas para arquivos e rede;
- possibilidade de empacotar o `rclone` junto.

Desafios para o SaveMe:

- o daemon precisa rodar fora do ciclo de vida do app. Um serviço D-Bus
  de sessão e um `systemd --user` dentro do sandbox exigem configuração
  específica e podem não funcionar como um serviço normal;
- o acesso a pastas arbitrárias, discos removíveis e montagens precisa
  passar por portals ou permissões amplas;
- a extensão do GNOME Shell não pode ser instalada pelo Flatpak. Ela
  continuaria sendo um pacote separado, o que quebra a instalação em uma
  etapa só;
- OAuth do rclone com navegador e callback local precisa ser testado
  dentro do sandbox.

Flatpak é viável para a interface, mas o daemon e a extensão continuam
sendo um problema de arquitetura.

## Snap

Snap permite publicar o app e serviços no mesmo pacote. O `snapcraft`
suporta `daemon` para serviços e `apps` para comandos.

Pontos positivos:

- um único pacote pode conter app, daemon e `rclone`;
- atualizações automáticas;
- integração com a Snap Store.

Desafios para o SaveMe:

- serviços Snap são normalmente de sistema, enquanto o SaveMe usa
  `systemd --user` e D-Bus de sessão;
- acesso ao home, unidades removíveis e arquivos ocultos exige interfaces
  como `home`, `removable-media` e `personal-files`, com revisão;
- a extensão do GNOME Shell não é instalada pelo Snap;
- OAuth e abertura do navegador podem esbarrar no confinamento;
- o modo `classic` reduz o isolamento e passa por revisão manual.

Snap parece mais próximo do modelo tudo-em-um, mas ainda precisa de um
protótipo para validar daemon, D-Bus, unidades removíveis e extensão.

## .deb

O `.deb` é o formato atual e o que melhor cobre a arquitetura:

- instala app, daemon, serviço `systemd --user`, D-Bus, autostart,
  a CLI e o `rclone`;
- permite acesso direto a montagens e unidades removíveis;
- integra com o `apt` e com o fluxo de atualização do sistema.

A desvantagem é ser específico para Debian/Ubuntu e não ter sandbox.

## Repositório APT

O repositório assinado fica em
`https://chrismaille.github.io/saveme/`. Ele é atualizado a cada release e
permite que o sistema receba novas versões com `sudo apt upgrade`.

O instalador por script continua sendo o caminho mais simples para a primeira
instalação porque também instala e ativa a extensão do GNOME. Depois, o APT
cuida das atualizações do aplicativo, daemon, D-Bus e CLI.

## Recomendação

1. Manter o `.deb` com repositório APT como canal principal no Linux.
2. Usar o script para a primeira instalação e para a extensão.
3. Prototipar Snap antes de Flatpak, porque o Snap consegue empacotar o
   daemon e o app juntos.
4. Se o Flatpak for necessário para o Flathub, separar claramente:
   app Flatpak + daemon/extensão instalados por um pacote do sistema.
5. Não investir em AppImage para este produto.

A decisão final sobre Snap/Flathub depende de testes reais com D-Bus de
sessão, unidades removíveis e OAuth em cada formato.
