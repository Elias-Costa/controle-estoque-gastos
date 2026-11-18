import { exigirDestinoDeTeste, type AmbienteDeTeste } from '../ambiente-de-teste.ts'
import { validarDestinoDeProducao } from '../lembretes/destino.ts'
import { FalhaGoogle } from './google.ts'

/** D-081/085: origem pública confirmada; não é extraída de credenciais. */
export const ORIGEM_BACKUP_PRODUCAO = 'https://awmesexptpalzonbucwc.supabase.co'
/** Configuração administrativa; não amplia os ambientes das suítes D-050. */
export type AmbienteBackup = AmbienteDeTeste | 'producao'

/** Reutiliza somente a guarda pura D-081, sem material ou jobs dos lembretes. */
export function exigirDestinoConfiguracaoBackup(projeto?: string): AmbienteBackup {
  if (projeto === undefined) return exigirDestinoDeTeste()
  if (process.env.AMBIENTE_DE_TESTE !== undefined || process.env.INTEGRACAO || process.env.VITE_LABORATORIO) {
    throw new FalhaGoogle('Configuração de produção recusa variáveis de teste ou laboratório; use um terminal próprio.')
  }
  try { validarDestinoDeProducao(projeto, process.env.VITE_SUPABASE_URL, process.env.SUPABASE_DB_URL) }
  catch { throw new FalhaGoogle('API e Postgres precisam pertencer ao projeto de produção confirmado no argumento, com conexão direta ou Session pooler na porta 5432.') }
  return 'producao'
}

/** D-085: seleciona uma conta existente, sem inferir o primeiro usuário ou pedir senha. */
export function validarContaBackup(conta: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conta)) throw new FalhaGoogle('Informe o UUID da conta Fichinhas a conferir no Auth.')
  return conta.toLowerCase()
}
