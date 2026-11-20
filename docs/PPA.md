# PPA no Launchpad

O PPA é o próximo canal de distribuição para Ubuntu:

```text
ppa:chrismaille/saveme
```

Ele é um repositório APT separado do arquivo oficial do Ubuntu. O Launchpad
compila e assina os pacotes.

## Pré-requisitos

- Conta no Launchpad.
- Chave GPG registrada na conta.
- Código de Conduta do Ubuntu assinado.
- PPA `saveme` criado em `https://launchpad.net/~chrismaille/+archive/ubuntu/saveme`.
- `dput`, `dpkg-dev`, `debhelper` (opcional) e `gpg` instalados localmente.

## Gerar o pacote-fonte

O projeto usa um `debian/` próprio, sem debhelper, para não depender de
ferramentas de build no repositório:

```bash
./scripts/build-ppa-source.sh -sa
```

O script:

- copia a árvore limpa para `build/ppa`;
- gera `saveme_<versão>.orig.tar.gz`;
- executa `dpkg-buildpackage -S -sa`;
- deixa o `.dsc` e o `.changes` em `build/ppa`.

Para testar sem assinar:

```bash
./scripts/build-ppa-source.sh -sa -us -uc -d
```

## Enviar

```bash
dput ppa:chrismaille/saveme \
  build/ppa/saveme_<versão>_source.changes
```

O Launchpad vai:

1. verificar a assinatura e o pacote-fonte;
2. compilar para a série indicada no `debian/changelog`;
3. assinar o repositório;
4. publicar o binário.

## Instalar

```bash
sudo add-apt-repository ppa:chrismaille/saveme
sudo apt update
sudo apt install saveme
```

Depois, `sudo apt upgrade` mantém o aplicativo atualizado.

## Versão

O `debian/changelog` é sincronizado pelo semantic-release. A versão do PPA
segue o formato:

```text
1.2.0-0ubuntu1
```

A parte `1.2.0` é a versão upstream; `-0ubuntu1` é a revisão do pacote.

## Séries do Ubuntu

O `debian/changelog` atual aponta para `resolute` (Ubuntu 26.04). Para publicar
em outra série, ajuste a distribuição no changelog e envie novamente:

```bash
dch --distribution <série> --release
./scripts/build-ppa-source.sh -sa
dput ppa:chrismaille/saveme build/ppa/saveme_<versão>_source.changes
```

## Diferenças em relação ao APT próprio

- O APT próprio em GitHub Pages é atualizado automaticamente pelo workflow de
  release e não depende do Launchpad.
- O PPA exige upload manual assinado (ou um fluxo separado com credenciais do
  Launchpad) e compila os binários no Launchpad.
- O PPA não coloca o app no App Center nem no arquivo oficial do Ubuntu; isso
  exige o processo descrito em [UBUNTU.md](UBUNTU.md).

## Rclone

O pacote do PPA usa o `rclone` do Ubuntu (`rclone >= 1.60`), em vez de embutir
o binário de 1.76. Isso é obrigatório para qualquer pacote Debian/Ubuntu sério.
Se a versão da série for antiga demais para algum recurso, o caminho é
atualizar o rclone ou declarar a dependência mínima correta.
