import { agendarLembretes, mostrarSegredosLembretes, prepararConfiguracaoLembretes } from './configurar.ts'
import { FalhaConfiguracaoLembretes } from './destino.ts'

/** Exige ação e confirmação explícitas antes de qualquer acesso à produção (D-081). */
export function comandoDeProducao(argumentos: readonly string[]): {
  acao: 'preparar' | 'segredos' | 'agendar'; projeto: string
} {
  const [acao, confirmacao] = argumentos
  if (argumentos.length !== 2 || (acao !== 'preparar' && acao !== 'segredos' && acao !== 'agendar') ||
    !confirmacao || !/^--projeto=[a-z0-9]{20}$/.test(confirmacao)) {
    throw new FalhaConfiguracaoLembretes('Use preparar, segredos ou agendar com --projeto=<identificador-confirmado-de-producao>.')
  }
  return { acao, projeto: confirmacao.slice('--projeto='.length) }
}

if (import.meta.main) {
  try {
    const { acao, projeto } = comandoDeProducao(process.argv.slice(2))
    if (acao === 'preparar') await prepararConfiguracaoLembretes(projeto)
    else if (acao === 'segredos') await mostrarSegredosLembretes(projeto)
    else await agendarLembretes(projeto)
  } catch (erro) {
    // O driver pode incluir conteúdo sensível no erro. A entrada de produção nunca o imprime.
    console.error(erro instanceof FalhaConfiguracaoLembretes ? erro.message :
      'Configuração de produção não concluída. Confira migrations e configuração do emissor; detalhes sensíveis omitidos.')
    process.exitCode = 1
  }
}
