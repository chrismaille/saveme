# Testes

## Automatizados

```bash
make test
```

Cobre:

- utilidades, configuração e validação de jobs
- fila/debounce do watcher
- sync completo, sync incremental, dry-run
- backup com versões e retenção
- guarda de deleção (full e incremental)
- origem vazia/ausente
- filtros padrão
- watcher real com criação, alteração, rename e delete

O CI roda os mesmos testes em `.github/workflows/ci.yml`.

## Manual — antes de publicar

Use uma instalação limpa do Ubuntu 26.04.

### Instalação

- [ ] `sudo apt install ./dist/saveme_*.deb`
- [ ] O daemon inicia no login ou com `saveme-daemon &`
- [ ] `saveme doctor` mostra rclone e paths corretos
- [ ] `saveme-settings` abre
- [ ] Extensão instala pelo EGO ou pelo zip e fica **ACTIVE**
- [ ] Ícone aparece no painel e o popup abre sem erros

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

- [ ] Alterar o mesmo arquivo 3 vezes; 3 versões existem
- [ ] Restaurar versão atual e versão antiga
- [ ] Dry run de restore não escreve
- [ ] Apagar na origem; destino mantém a última cópia
- [ ] Retenção remove versões antigas

### Nuvem

- [ ] Sync local → Drive/OneDrive/Dropbox
- [ ] Sync nuvem → local (polling de 5 min)
- [ ] Sync nuvem → nuvem
- [ ] Backup local → nuvem com versões
- [ ] Ficar offline; job tenta com backoff e recupera depois
- [ ] Cancelar job em andamento

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
