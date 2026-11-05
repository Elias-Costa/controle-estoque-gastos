import type { SQL } from 'bun'
import { conectar } from '../migrar.ts'
import { exigirDestinoDeTeste } from '../ambiente-de-teste.ts'
import { consultarAutorizacaoGoogle } from './cofre-google.ts'
import { FalhaGoogle } from './google.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'

const SEGREDO = 'fichinhas-backup-servico-v1', JOB = 'fichinhas-backup'
async function lerToken(sql: SQL): Promise<string | null> {
  const r = await sql<{ valor: string }[]>`select decrypted_secret valor from vault.decrypted_secrets where name=${SEGREDO}`
  if (r.length === 0) return null
  const token = r[0]?.valor
  if (r.length !== 1 || !token || !/^[a-f0-9]{64}$/.test(token)) throw new FalhaGoogle('Token existente inválido; preservado para conferência.')
  return token
}

/** Prepara só material próprio no Vault e imprime seu hash público para configurar o Edge de teste. */
export async function prepararBackup(): Promise<void> {
  const ambiente = exigirDestinoDeTeste(), sql = conectar()
  try {
    const autorizacao = await consultarAutorizacaoGoogle(sql)
    if (!autorizacao || autorizacao.destino !== new URL(process.env.VITE_SUPABASE_URL ?? '').origin || autorizacao.ambiente !== ambiente) throw new FalhaGoogle('Autorize primeiro o Google neste destino de teste.')
    const token = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('fichinhas-backup-servico-v1',84))`
      let atual = await lerToken(tx)
      if (!atual) {
        atual = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
        await tx`select vault.create_secret(${atual},${SEGREDO},'D-084: token próprio do cron; nunca usar como credencial do app.')`
      }
      return atual
    })
    console.log(JSON.stringify({ ambiente, funcao: 'enviar-backup', BACKUP_TOKEN_SHA256: await hashDaFoto(new TextEncoder().encode(token)),
      agendado: false, segredosImpressos: false }))
  } finally { await sql.close() }
}

/** Instala/conserva somente o job próprio depois dos negativos/saúde do handler publicado. */
export async function agendarBackup(): Promise<void> {
  const ambiente = exigirDestinoDeTeste(), sql = conectar()
  try {
    const token = await lerToken(sql), api = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
    if (!token || !api) throw new FalhaGoogle('Prepare primeiro o serviço de backup neste destino.')
    const endpoint = api + '/functions/v1/enviar-backup'
    const pedir = (body: string, autenticar = true) => fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', ...(autenticar ? { authorization: `Bearer ${token}` } : {}) }, body })
    const semToken = await pedir('{}', false), invalido = await pedir('{"invalido":true}')
    if (semToken.status !== 401 || invalido.status !== 400) throw new FalhaGoogle('Negativos HTTP não passaram; nenhum job criado.')
    const saude = await pedir('{"verificar":true}'), r: unknown = await saude.json()
    if (!saude.ok || typeof r !== 'object' || r === null || !('pronto' in r) || r.pronto !== true) throw new FalhaGoogle('Handler/configuração ainda não conferidos; nenhum job criado.')
    await sql.begin(async (tx) => {
      await tx.unsafe('create extension if not exists pg_cron; create extension if not exists pg_net with schema extensions')
      const papeis = await tx<{ rolcanlogin: boolean; vault: boolean }[]>`select rolcanlogin,has_table_privilege(rolname::text,'vault.decrypted_secrets','select') vault
        from pg_roles where rolname in ('anon','authenticated')`
      if (papeis.length !== 2 || papeis.some((p) => p.rolcanlogin || p.vault)) throw new FalhaGoogle('Papéis do app alcançam material do cron; nenhum job criado.')
      const fila = await fetch(api + '/rest/v1/http_request_queue?select=id&limit=0', { redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '', authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY ?? ''}`, 'accept-profile': 'net' } })
      const resposta: unknown = await fila.json()
      if (fila.status !== 406 || typeof resposta !== 'object' || resposta === null || !('code' in resposta) || resposta.code !== 'PGRST106') throw new FalhaGoogle('Fila HTTP não conferida fora da Data API; nenhum job criado.')
      const [fuso] = await tx<{ valor: string | null }[]>`select current_setting('cron.timezone',true) valor`
      if (fuso?.valor && !['UTC', 'GMT', 'Etc/UTC'].includes(fuso.valor)) throw new FalhaGoogle('Conferir o fuso do cron antes de agendar.')
      const interno = ambiente === 'local' ? 'http://kong:8000/functions/v1/enviar-backup' : endpoint
      const comando = `select net.http_post(url := '${interno}', headers := jsonb_build_object('Content-Type','application/json','Authorization',
        (select 'Bearer ' || decrypted_secret from vault.decrypted_secrets where name='${SEGREDO}')), body := '{}'::jsonb, timeout_milliseconds := 120000);`
      // D-082/084: uma captura diária às 11h; as outras oportunidades retomam a mesma captura, sem nova data.
      const horario = '0,10,20,30,40,50 14 * * *'
      const existentes = await tx<{ command: string; schedule: string; active: boolean }[]>`select command,schedule,active from cron.job where jobname=${JOB}`
      if (existentes.length) {
        if (existentes.length !== 1 || existentes[0]?.command !== comando || existentes[0]?.schedule !== horario || !existentes[0]?.active) throw new FalhaGoogle('Job preexistente diferente; preservado para conferência.')
      } else await tx`select cron.schedule(${JOB},${horario},${comando})`
    })
    console.log(JSON.stringify({ ambiente, job: JOB, inicioFortaleza: '11:00', recuperacoesAte: '11:50', segredosImpressos: false }))
  } finally { await sql.close() }
}
if (import.meta.main) {
  try {
    if (process.argv[2] === 'preparar') await prepararBackup()
    else if (process.argv[2] === 'agendar') await agendarBackup()
    else throw new FalhaGoogle('Use preparar ou agendar pelo comando do ambiente de teste.')
  } catch (e) { console.error(e instanceof FalhaGoogle ? e.message : 'Configuração do backup não concluída; detalhes sensíveis omitidos.'); process.exitCode = 1 }
}
