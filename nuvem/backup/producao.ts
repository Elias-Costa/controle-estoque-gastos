import { agendarBackup, prepararBackup } from './configurar.ts'
import { configurarGoogle } from './configurar-google.ts'
import { validarContaBackup } from './destino.ts'
import { FalhaGoogle } from './google.ts'

/** Comandos próprios D-085; nenhuma ação aplica migrations, semeia dados ou publica Edge. */
export function comandoBackupProducao(argumentos: readonly string[]):
  { acao: 'preparar' | 'agendar'; projeto: string } |
  { acao: 'autorizar' | 'reautorizar' | 'verificar'; projeto: string; contaId: string; caminho?: string } {
  const [acao, confirmacao, conta, caminho] = argumentos
  if (!confirmacao || !/^--projeto=[a-z0-9]{20}$/.test(confirmacao)) throw new FalhaGoogle('Informe --projeto=<identificador-confirmado-de-producao>.')
  const projeto = confirmacao.slice('--projeto='.length)
  if ((acao === 'preparar' || acao === 'agendar') && argumentos.length === 2) return { acao, projeto }
  if ((acao === 'autorizar' || acao === 'reautorizar' || acao === 'verificar') && conta?.startsWith('--conta=') &&
    (acao === 'verificar' ? argumentos.length === 3 : argumentos.length === 4 && !!caminho && !caminho.startsWith('--'))) {
    return { acao, projeto, contaId: validarContaBackup(conta.slice('--conta='.length)), ...(caminho ? { caminho } : {}) }
  }
  throw new FalhaGoogle('Use preparar/agendar com --projeto, ou autorizar/reautorizar/verificar com --projeto e --conta=<UUID>. Autorizar/reautorizar exigem também o caminho absoluto do JSON Desktop.')
}

if (import.meta.main) {
  try {
    const comando = comandoBackupProducao(process.argv.slice(2))
    if ('contaId' in comando) await configurarGoogle(comando.acao, comando.caminho, { projeto: comando.projeto, contaId: comando.contaId })
    else if (comando.acao === 'preparar') await prepararBackup(comando.projeto)
    else await agendarBackup(comando.projeto)
  } catch (erro) {
    console.error(erro instanceof FalhaGoogle ? erro.message : 'Configuração do backup em produção não concluída; detalhes sensíveis omitidos.')
    process.exitCode = 1
  }
}
