# Repositório APT

O SaveMe publica um repositório APT assinado no GitHub Pages:

```text
https://chrismaille.github.io/saveme/
```

## Uso

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://chrismaille.github.io/saveme/saveme-archive-keyring.gpg \
  | sudo tee /etc/apt/keyrings/saveme-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/saveme-archive-keyring.gpg] https://chrismaille.github.io/saveme/ stable main" \
  | sudo tee /etc/apt/sources.list.d/saveme.list
sudo apt update
sudo apt install saveme
```

Depois disso:

```bash
sudo apt upgrade
```

## Estrutura

```text
dists/stable/InRelease
dists/stable/Release
dists/stable/Release.gpg
dists/stable/main/binary-amd64/Packages
dists/stable/main/binary-amd64/Packages.gz
pool/main/s/saveme/saveme_<versão>_amd64.deb
saveme-archive-keyring.gpg
```

## Publicação

O workflow `Release` faz tudo em sequência:

1. o semantic-release cria a tag e a release;
2. o `.deb` e o zip da extensão são construídos;
3. os artefatos são anexados à release;
4. o repositório APT é gerado com `scripts/build-apt-repo.sh`;
5. o conteúdo é publicado na branch `gh-pages`.

O segredo `APT_GPG_PRIVATE_KEY` guarda a chave privada usada para assinar
`InRelease` e `Release.gpg`. A chave pública fica em
`data/apt/saveme-archive-keyring.gpg` e também é publicada na raiz do
repositório.

## Rotação da chave

Se a chave for comprometida ou precisar ser trocada:

1. gere uma nova chave GPG;
2. substitua `data/apt/saveme-archive-keyring.gpg` e o `.asc` pela chave
   pública nova;
3. atualize o segredo `APT_GPG_PRIVATE_KEY` no GitHub;
4. publique uma nova release.

Usuários que já confiaram na chave antiga precisam baixar a chave nova e
repetir a configuração do `signed-by`.

## Limitações atuais

- O repositório publica apenas `amd64`.
- A extensão do GNOME é instalada/atualizada pelo `scripts/install.sh`; o
  pacote APT atualiza o aplicativo, o daemon, o D-Bus e a CLI.
