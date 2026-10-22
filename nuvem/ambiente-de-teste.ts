import { PROJETO_DE_HOMOLOGACAO } from './destinos-de-teste.ts'

/** Ambientes autorizados para suítes que escrevem no Supabase (D-050). Produção não entra. */
export type AmbienteDeTeste = 'local' | 'homologacao'

/** Somente os campos necessários para conferir o destino, sem expor segredos. */
export type DestinoDeTeste = {
  readonly ambiente: string | undefined
  readonly api: string | undefined
  readonly banco: string | undefined
}

function lerUrl(valor: string | undefined): URL {
  try {
    if (!valor) throw new Error()
    return new URL(valor)
  } catch {
    // A mensagem de URL inválida pode incluir a senha; nunca propagar o erro original.
    throw new Error('Destino de teste ausente ou inválido. Confira a configuração do ambiente separado.')
  }
}

/** Recusa destino não confirmado e misturas entre API e banco antes de qualquer conexão (D-050). */
export function validarDestinoDeTeste(
  destino: DestinoDeTeste,
  projetoDeHomologacao: string | null = PROJETO_DE_HOMOLOGACAO,
): AmbienteDeTeste {
  if (destino.ambiente !== 'local' && destino.ambiente !== 'homologacao') {
    throw new Error('Selecione local ou homologacao pelo comando de testes. Produção não recebe suítes.')
  }
  const api = lerUrl(destino.api)
  const banco = lerUrl(destino.banco)
  if (api.username || api.password || api.search || api.hash || (api.pathname !== '/' && api.pathname !== '')) {
    throw new Error('A URL da API de teste precisa ser a raiz do projeto, sem credenciais ou parâmetros.')
  }
  if (!['postgres:', 'postgresql:'].includes(banco.protocol) || banco.pathname !== '/postgres' || banco.search || banco.hash) {
    throw new Error('Conexão Postgres de teste inválida; use o banco postgres sem parâmetros adicionais.')
  }
  if (destino.ambiente === 'local') {
    if (api.origin !== 'http://127.0.0.1:54321' || banco.hostname !== '127.0.0.1' || banco.port !== '54322' || banco.username !== 'postgres') {
      throw new Error('Testes locais só acessam a API 127.0.0.1:54321 e o Postgres 127.0.0.1:54322.')
    }
    return 'local'
  }
  if (projetoDeHomologacao === null || !/^[a-z0-9]{20}$/.test(projetoDeHomologacao)) {
    throw new Error('Homologação bloqueada: confirme o novo projeto com o mantenedor e registre seu identificador em nuvem/destinos-de-teste.ts.')
  }
  const direta = banco.hostname === `db.${projetoDeHomologacao}.supabase.co` && banco.username === 'postgres'
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(banco.hostname)
    && banco.username === `postgres.${projetoDeHomologacao}`
  if (api.origin !== `https://${projetoDeHomologacao}.supabase.co` || banco.port !== '5432' || (!direta && !pooler)) {
    throw new Error('API e Postgres precisam pertencer ao projeto de homologação confirmado; pooler deve ser de sessão na porta 5432.')
  }
  return 'homologacao'
}

/** Confere as variáveis do processo sem ler arquivos nem fazer rede. */
export function exigirDestinoDeTeste(): AmbienteDeTeste {
  return validarDestinoDeTeste({
    ambiente: process.env.AMBIENTE_DE_TESTE,
    api: process.env.VITE_SUPABASE_URL,
    banco: process.env.SUPABASE_DB_URL,
  })
}
