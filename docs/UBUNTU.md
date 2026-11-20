# Ubuntu: PPA e arquivo oficial

Existem dois níveis diferentes de "estar no APT do Ubuntu". Eles não são a
mesma coisa.

## 1. PPA (próximo passo natural)

Um PPA é um repositório APT pessoal hospedado no Launchpad. Para o usuário, a
experiência é:

```bash
sudo add-apt-repository ppa:<usuario-launchpad>/saveme
sudo apt update
sudo apt install saveme
```

O Launchpad:

- recebe um pacote-fonte assinado;
- compila para cada série do Ubuntu;
- assina o repositório automaticamente;
- publica os binários para `apt`.

O usuário não precisa adicionar chave GPG manualmente.

### O que precisa ser feito

1. Criar conta no Launchpad e assinar o Código de Conduta.
2. Registrar a chave GPG da conta no Launchpad.
3. Criar o PPA `saveme`.
4. Adicionar o `debian/` do projeto (já incluído no repositório).
5. Gerar e assinar o pacote-fonte:

   ```bash
   ./scripts/build-ppa-source.sh -sa -k<KEYID>
   ```

6. Enviar para o PPA:

   ```bash
   dput ppa:<usuario-launchpad>/saveme \
     build/ppa/saveme_<versão>_source.changes
   ```

7. Esperar o build no Launchpad e testar a instalação.

O PPA continua sendo um repositório separado do Ubuntu oficial. Ele resolve
integração com `apt` e distribuição para usuários Ubuntu, mas não coloca o
aplicativo no arquivo oficial nem no App Center.

### Limitação do PPA

O Launchpad compila a partir do código-fonte. Ele não aceita simplesmente o
`.deb` que o `scripts/build-deb.sh` gera hoje. Também não é adequado embutir o
binário do `rclone` dentro do pacote-fonte: o pacote do PPA depende do
`rclone` do Ubuntu.

## 2. Arquivo oficial do Ubuntu

É o que faz o SaveMe aparecer no `universe` (e futuramente no `main`) sem o
usuário adicionar PPA. O fluxo é bem mais rigoroso.

### Requisitos

- Pacote-fonte Debian completo e limpo.
- Build reproduzível a partir do código-fonte.
- Dependências disponíveis no Ubuntu; nada de binário embutido sem necessidade.
- `lintian` limpo ou com exceções justificadas.
- Testes automatizados (idealmente `autopkgtest`).
- `debian/copyright` correto para todo o código e assets.
- Manpages para os comandos instalados.
- Extensão do GNOME empacotada como extensão de sistema, com estratégia clara
  de ativação por usuário.
- Um mantenedor responsável e, na prática, um patrocinador/sponsor que revise
  e faça o upload.

### Processo

1. Empacotar no Debian ou preparar um pacote-fonte diretamente para Ubuntu.
2. Abrir um bug de ITP (Intent To Package) e procurar um sponsor.
3. Upload para o `universe`.
4. Revisão do archive admin.
5. O pacote entra na próxima versão do Ubuntu.

### O que não é automático

- Uma release nova no GitHub não entra sozinha no arquivo oficial.
- Atualizações de funcionalidade em uma versão estável do Ubuntu normalmente
  não são aceitas; o caminho é backports ou uma nova versão do Ubuntu.
- O `main` exige revisão de inclusão (MIR), segurança e manutenção contínua;
  `universe` é o alvo realista no começo.

## Situação atual do SaveMe

O pacote-fonte do PPA já está pronto em `debian/` e é publicado como anexo das
releases. O upload ao Launchpad depende da conta e da chave GPG do mantenedor.

Antes do arquivo oficial, ainda faltam:

1. definir como a extensão do GNOME será instalada e ativada;
2. validar as contas reais dos provedores de nuvem;
3. rodar `lintian` e testes `autopkgtest`;
4. encontrar um sponsor para o upload no Ubuntu.

## Ordem recomendada

1. Publicar o PPA para distribuição Ubuntu com `apt upgrade`.
2. Depois de estabilizar o pacote-fonte e a extensão, buscar o `universe`.
3. Snap Store/Flathub são canais separados, com os desafios de daemon e
   extensão já documentados em [DISTRIBUTION.md](DISTRIBUTION.md).
