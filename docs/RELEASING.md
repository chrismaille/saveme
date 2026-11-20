# Versionamento e releases

O SaveMe usa [Conventional Commits](https://www.conventionalcommits.org/)
e [semantic-release](https://semantic-release.gitbook.io/).

## Mensagens de commit

O título do commit precisa seguir o formato:

```text
tipo(escopo opcional): descrição curta
```

Tipos usados para calcular a versão:

- `fix:` corrige um bug e gera uma versão de patch (`1.0.1`).
- `feat:` adiciona uma funcionalidade e gera uma versão minor (`1.1.0`).
- `feat!:` ou `BREAKING CHANGE:` no corpo gera uma versão major (`2.0.0`).
- `docs:`, `test:`, `chore:`, `refactor:`, `style:` e `ci:` não geram
  release sozinhos.

Exemplos:

```text
fix(jobs): show the source change before starting the backup
feat(ui): edit the delete guard from the job details
chore(release): 1.2.0 [skip ci]
```

O commit de release é criado automaticamente e não deve ser editado.

## Fluxo local

Instale os hooks uma vez:

```bash
make setup-hooks
```

Depois:

```bash
git add .
git commit -m "fix(jobs): explica por que o backup foi bloqueado"
git push origin main
```

O hook `commitlint` valida a mensagem no `git commit`. Para testar sem
criar o commit:

```bash
echo "fix(jobs): mensagem de teste" | npx commitlint
```

## O que o GitHub Actions faz

Ao receber um push na `main`, o workflow `Release`:

1. instala as dependências;
2. analisa os commits desde a última tag;
3. calcula a próxima versão;
4. atualiza `package.json`, `package-lock.json`, `src/daemon.js` e
   `scripts/build-deb.sh`;
5. atualiza `CHANGELOG.md`;
6. cria a tag `vX.Y.Z` e a release no GitHub;
7. constrói o `.deb` e a extensão;
8. gera os arquivos-fonte do PPA;
9. anexa os artefatos à release.

O upload ao Launchpad continua manual, porque exige a chave GPG da conta.
Veja [PPA.md](PPA.md). O empacotamento Snap/Flatpak ainda não faz parte do
workflow.

## Primeira release

Como o repositório ainda não tem tags, a primeira release criada pelo
semantic-release será `1.0.0`. Depois disso, a versão passa a ser
calculada pelos commits convencionais.
