import { exigirDestinoDeTeste, type AmbienteDeTeste } from '../ambiente-de-teste.ts'
import { PROJETO_DE_HOMOLOGACAO } from '../destinos-de-teste.ts'

// Identificador público confirmado pelo mantenedor na D-081; nunca inferir das credenciais.
const PROJETO_DE_PRODUCAO = 'awmesexptpalzonbucwc'

/** Diagnóstico deliberado sem URLs privadas ou respostas do driver. */
export class FalhaConfiguracaoLembretes extends Error {}

/** Confere o projeto informado pelo mantenedor sem conectar ou expor a URL com senha (D-081). */
export function validarDestinoDeProducao(projeto: string, api: string | undefined, banco: string | undefined): void {
  if (projeto !== PROJETO_DE_PRODUCAO || projeto === PROJETO_DE_HOMOLOGACAO) {
    throw new FalhaConfiguracaoLembretes('Informe o identificador de produção confirmado; homologação não é produção.')
  }
  try {
    if (!api || !banco) throw new Error()
    const origem = new URL(api), conexao = new URL(banco)
    const direta = conexao.hostname === `db.${projeto}.supabase.co` && conexao.username === 'postgres'
    const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(conexao.hostname) && conexao.username === `postgres.${projeto}`
    if (origem.origin !== `https://${projeto}.supabase.co` || origem.username || origem.password ||
      origem.search || origem.hash || origem.pathname !== '/' ||
      !['postgres:', 'postgresql:'].includes(conexao.protocol) || conexao.pathname !== '/postgres' ||
      conexao.port !== '5432' || conexao.search || conexao.hash || (!direta && !pooler)) throw new Error()
  } catch {
    throw new FalhaConfiguracaoLembretes('API e Postgres precisam pertencer ao projeto de produção confirmado, com conexão direta ou Session pooler na porta 5432.')
  }
}

/** Produção só entra na configuração explícita; a guarda das suítes continua exclusiva de testes. */
export function exigirDestinoConfiguracaoLembretes(projetoDeProducao?: string): AmbienteDeTeste | 'producao' {
  if (projetoDeProducao === undefined) return exigirDestinoDeTeste()
  if (process.env.AMBIENTE_DE_TESTE !== undefined || process.env.INTEGRACAO || process.env.VITE_LABORATORIO) {
    throw new FalhaConfiguracaoLembretes('Configuração de produção recusa variáveis de teste ou laboratório; use um terminal próprio.')
  }
  validarDestinoDeProducao(projetoDeProducao, process.env.VITE_SUPABASE_URL, process.env.SUPABASE_DB_URL)
  return 'producao'
}
