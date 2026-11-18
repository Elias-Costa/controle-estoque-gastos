import type { SQL } from 'bun'
import { PROJETO_DE_HOMOLOGACAO } from '../destinos-de-teste.ts'
import { ORIGEM_BACKUP_PRODUCAO, type AmbienteBackup } from './destino.ts'
import { FalhaGoogle, lerClienteGoogle, PROJETO_GOOGLE_DE_TESTE, PROJETO_GOOGLE_DE_PRODUCAO, type ClienteGoogle } from './google.ts'

/** Nome próprio: nunca ler, reutilizar ou alterar material dos lembretes. */
export const SEGREDO_GOOGLE_BACKUP = 'fichinhas-backup-google-homologacao-v1'
/** D-085: autorização definitiva nova; nunca copiar o cofre de homologação. */
export const SEGREDO_GOOGLE_BACKUP_PRODUCAO = 'fichinhas-backup-google-producao-v1'
function exigirNome(nome: string): void {
  // Provas SQL usam nomes próprios e rollback, sem ler/substituir a autorização real já configurada.
  if (![SEGREDO_GOOGLE_BACKUP, SEGREDO_GOOGLE_BACKUP_PRODUCAO].some((base) => nome === base ||
    new RegExp(`^${base}:teste:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(nome))) {
    throw new FalhaGoogle('Nome de cofre fora do backup.')
  }
}
function conferirAmbienteDoNome(nome: string, autorizacao: AutorizacaoGoogle): void {
  if ((autorizacao.ambiente === 'producao') !== nome.startsWith(SEGREDO_GOOGLE_BACKUP_PRODUCAO)) {
    throw new FalhaGoogle('Cofre e ambiente da autorização divergem; nenhuma substituição foi feita.')
  }
}
/** Vínculo fechado da autorização ao ambiente, destino e conta Fichinhas (D-050/084/085). */
export type AutorizacaoGoogle = { readonly formato: 1; readonly ambiente: AmbienteBackup; readonly destino: string
  readonly contaId: string; readonly contaGoogleId: string; readonly cliente: ClienteGoogle; readonly renovacao: string; readonly autorizadoEm: string }

/** Valida também material já guardado; formato desconhecido não é reparado nem substituído. */
export function lerAutorizacaoGoogle(v: unknown): AutorizacaoGoogle {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FalhaGoogle('Autorização guardada inválida; preservar para conferência.')
  if (!('formato' in v) || v.formato !== 1 || !('ambiente' in v) || (v.ambiente !== 'local' && v.ambiente !== 'homologacao' && v.ambiente !== 'producao') ||
    !('destino' in v) || typeof v.destino !== 'string' || !('contaId' in v) || typeof v.contaId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v.contaId) ||
    !('contaGoogleId' in v) || typeof v.contaGoogleId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(v.contaGoogleId) ||
    !('renovacao' in v) || typeof v.renovacao !== 'string' || v.renovacao.length === 0 || v.renovacao.length > 4096 ||
    !('autorizadoEm' in v) || typeof v.autorizadoEm !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v.autorizadoEm) || Number.isNaN(Date.parse(v.autorizadoEm)) ||
    !('cliente' in v) || typeof v.cliente !== 'object' || v.cliente === null ||
    !('clienteId' in v.cliente) || !('projetoId' in v.cliente) || !('segredo' in v.cliente) ||
    Object.keys(v).sort().join(',') !== 'ambiente,autorizadoEm,cliente,contaGoogleId,contaId,destino,formato,renovacao' ||
    Object.keys(v.cliente).sort().join(',') !== 'clienteId,projetoId,segredo') {
    throw new FalhaGoogle('Autorização guardada inválida; preservar para conferência.')
  }
  const ambiente = v.ambiente
  const destino = ambiente === 'local' ? 'http://127.0.0.1:54321' : ambiente === 'producao' ? ORIGEM_BACKUP_PRODUCAO : `https://${PROJETO_DE_HOMOLOGACAO}.supabase.co`
  if (v.destino !== destino) throw new FalhaGoogle('Autorização pertence a outro destino.')
  const cliente = lerClienteGoogle({ installed: { project_id: v.cliente.projetoId, client_id: v.cliente.clienteId,
    client_secret: v.cliente.segredo, auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'] } },
  ambiente === 'producao' ? PROJETO_GOOGLE_DE_PRODUCAO : PROJETO_GOOGLE_DE_TESTE)
  return { formato: 1, ambiente, destino, contaId: v.contaId, contaGoogleId: v.contaGoogleId, cliente, renovacao: v.renovacao, autorizadoEm: v.autorizadoEm }
}

/** Somente servidor/configurador: lê o cofre sem imprimir o resultado nem conceder acesso ao app. */
export async function consultarAutorizacaoGoogle(sql: SQL, nome = SEGREDO_GOOGLE_BACKUP): Promise<AutorizacaoGoogle | null> {
  exigirNome(nome)
  const linhas = await sql<{ valor: string }[]>`select decrypted_secret valor from vault.decrypted_secrets where name=${nome}`
  if (linhas.length === 0) return null
  if (linhas.length !== 1) throw new FalhaGoogle('Há mais de uma autorização guardada; preservar para conferência.')
  try { const autorizacao = lerAutorizacaoGoogle(JSON.parse(linhas[0]?.valor ?? '')); conferirAmbienteDoNome(nome, autorizacao); return autorizacao }
  catch { throw new FalhaGoogle('Autorização guardada inválida; preservar para conferência.') }
}

/** Chamar numa transação: trava e comparação impedem sobrescrever uma autorização concorrente. */
export async function registrarAutorizacaoGoogle(tx: SQL, valor: AutorizacaoGoogle, anterior: AutorizacaoGoogle | null, nome = SEGREDO_GOOGLE_BACKUP): Promise<void> {
  exigirNome(nome)
  const nova = lerAutorizacaoGoogle(valor)
  conferirAmbienteDoNome(nome, nova)
  await tx`select pg_advisory_xact_lock(hashtextextended(${nome},2))`
  const atual = await consultarAutorizacaoGoogle(tx, nome)
  if (JSON.stringify(atual) !== JSON.stringify(anterior)) throw new FalhaGoogle('A autorização mudou durante a tentativa; nenhuma substituição foi feita.')
  if (atual && (atual.contaGoogleId !== nova.contaGoogleId || atual.contaId !== nova.contaId || atual.destino !== nova.destino || atual.cliente.clienteId !== nova.cliente.clienteId)) {
    throw new FalhaGoogle('Reautorizar não pode trocar conta, cliente ou destino.')
  }
  if (atual) {
    const linhas = await tx<{ id: string }[]>`select id::text from vault.secrets where name=${nome}`
    const id = linhas[0]?.id
    if (linhas.length !== 1 || !id) throw new FalhaGoogle('Autorização existente não localizada; preservada.')
    await tx`select vault.update_secret(${id}::uuid,${JSON.stringify(nova)})`
  } else {
    await tx`select vault.create_secret(${JSON.stringify(nova)},${nome},${`D-084/085: OAuth ${nova.cliente.projetoId}; nunca expor ao app.`})`
  }
}
