import type { SQL } from 'bun'
import { conectar } from '../migrar.ts'
import { exigirDestinoConfiguracaoLembretes, FalhaConfiguracaoLembretes as FalhaConfiguracao } from './destino.ts'

const NOME_SEGREDO = 'fichinhas-lembretes-v1'
const NOME_JOB = 'fichinhas-lembretes'
type Segredo = { readonly token: string; readonly chaves: { readonly publicKey: JsonWebKey; readonly privateKey: JsonWebKey } }
async function lerSegredo(sql: SQL): Promise<Segredo | null> {
  const linhas = await sql<{ valor: string }[]>`select decrypted_secret valor from vault.decrypted_secrets where name=${NOME_SEGREDO}`
  if (linhas.length === 0) return null
  const valor: unknown = JSON.parse(linhas[0]?.valor ?? '')
  if (linhas.length !== 1 || typeof valor !== 'object' || valor === null || !('token' in valor) || typeof valor.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(valor.token) || !('chaves' in valor) || typeof valor.chaves !== 'object' || valor.chaves === null ||
    !('publicKey' in valor.chaves) || !('privateKey' in valor.chaves) || typeof valor.chaves.publicKey !== 'object' || valor.chaves.publicKey === null ||
    typeof valor.chaves.privateKey !== 'object' || valor.chaves.privateKey === null) throw new FalhaConfiguracao('Segredo existente inválido; preservar e conferir.')
  return { token: valor.token, chaves: { publicKey: valor.chaves.publicKey, privateKey: valor.chaves.privateKey } }
}
async function dadosPublicos(segredo: Segredo) {
  const chave = await crypto.subtle.importKey('jwk', segredo.chaves.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  return { chavePublica: Buffer.from(await crypto.subtle.exportKey('raw', chave)).toString('base64url'),
    tokenHash: Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(segredo.token))).toString('hex') }
}

/** Prepara o destino validado sem agendar, publicar função ou imprimir credenciais (D-079/081). */
export async function prepararConfiguracaoLembretes(projetoDeProducao?: string): Promise<void> {
  const ambiente = exigirDestinoConfiguracaoLembretes(projetoDeProducao)
  const sql = conectar()
  try {
    const publico = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('fichinhas-lembretes-configuracao',38))`
      let segredo = await lerSegredo(tx)
      if (!segredo) {
        const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        segredo = { token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), chaves: {
          publicKey: await crypto.subtle.exportKey('jwk', par.publicKey), privateKey: await crypto.subtle.exportKey('jwk', par.privateKey) } }
        await tx`select vault.create_secret(${JSON.stringify(segredo)},${NOME_SEGREDO},'D-079/081: chaves deste projeto; não expirar ou rotacionar automaticamente.')`
      }
      const dados = await dadosPublicos(segredo)
      await tx`insert into lembretes_interno.configuracao(chave,chave_publica) values(true,${dados.chavePublica}) on conflict do nothing`
      const [atual] = await tx<{ chave_publica: string }[]>`select chave_publica from lembretes_interno.configuracao where chave`
      if (atual?.chave_publica !== dados.chavePublica) throw new FalhaConfiguracao('Chave pública já configurada diverge; nenhuma rotação foi feita.')
      return dados
    })
    console.log(JSON.stringify({ ambiente, funcao: 'enviar-lembretes', ...publico, agendado: false, segredos_impressos: false }))
  } finally { await sql.close() }
}

/** Exibição manual em terminal interativo; recusa saída redirecionada para arquivo/pipeline. */
export async function mostrarSegredosLembretes(projetoDeProducao?: string): Promise<void> {
  exigirDestinoConfiguracaoLembretes(projetoDeProducao)
  if (!process.stdout.isTTY) throw new FalhaConfiguracao('Execute este comando no seu terminal, sem redirecionar a saída.')
  const sql = conectar()
  try {
    const segredo = await lerSegredo(sql)
    if (!segredo) throw new FalhaConfiguracao('Prepare primeiro os lembretes neste mesmo projeto.')
    const dados = await dadosPublicos(segredo)
    console.log('Copie os três valores para os segredos da função Edge deste mesmo projeto. Não salve em arquivo, chat ou log.')
    console.log('LEMBRETES_TOKEN_SHA256=' + dados.tokenHash)
    console.log('LEMBRETES_VAPID_CONTATO=' + process.env.VITE_SUPABASE_URL)
    console.log('LEMBRETES_VAPID_CHAVES=' + JSON.stringify(segredo.chaves))
  } finally { await sql.close() }
}

/** Confere o handler publicado antes de instalar o job; token nunca aparece no comando cron. */
export async function agendarLembretes(projetoDeProducao?: string): Promise<void> {
  const ambiente = exigirDestinoConfiguracaoLembretes(projetoDeProducao)
  const api = process.env.VITE_SUPABASE_URL
  const anonima = process.env.VITE_SUPABASE_ANON_KEY
  if (!api || !anonima) throw new FalhaConfiguracao('Configuração da API ausente.')
  const sql = conectar()
  try {
    const segredo = await lerSegredo(sql)
    if (!segredo) throw new FalhaConfiguracao('Prepare primeiro os lembretes neste mesmo projeto.')
    const endpoint = `${new URL(api).origin}/functions/v1/enviar-lembretes`
    const consultar = (body: string, autenticar = true) => fetch(endpoint, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(autenticar ? { authorization: `Bearer ${segredo.token}` } : {}) }, body, signal: AbortSignal.timeout(20_000) })
    const semToken = await consultar('{}', false), corpoInvalido = await consultar('{"invalido":true}')
    if (semToken.status !== 401 || corpoInvalido.status !== 400) {
      const origem = async (resposta: Response) => {
        try {
          const corpo: unknown = await resposta.json()
          return typeof corpo === 'object' && corpo !== null ? ('erro' in corpo ? 'handler' : 'code' in corpo ? 'gateway' : 'desconhecida') : 'desconhecida'
        } catch { return 'desconhecida' }
      }
      console.log(JSON.stringify({ semToken: { status: semToken.status, origem: await origem(semToken) },
        corpoInvalido: { status: corpoInvalido.status, origem: await origem(corpoInvalido) }, segredos_impressos: false }))
      throw new FalhaConfiguracao('O handler não passou nos negativos HTTP; nenhum job criado.')
    }
    const pronto = await consultar('{"verificar":true}')
    const saude: unknown = await pronto.json()
    if (!pronto.ok || typeof saude !== 'object' || saude === null || !('pronto' in saude) || saude.pronto !== true) {
      const etapa = typeof saude === 'object' && saude !== null && 'erro' in saude &&
        ['configuracao_do_emissor', 'acesso_ao_banco', 'indisponivel'].includes(String(saude.erro)) ? String(saude.erro) : 'desconhecida'
      const statusBanco = typeof saude === 'object' && saude !== null && 'statusBanco' in saude && typeof saude.statusBanco === 'number' ? saude.statusBanco : null
      const configuracao = typeof saude === 'object' && saude !== null && 'etapa' in saude &&
        ['chaves_ausentes', 'json_chaves', 'formato_chaves', 'importacao_chaves', 'servidor_push'].includes(String(saude.etapa)) ? String(saude.etapa) : null
      console.log(JSON.stringify({ verificacao: { status: pronto.status, etapa, configuracao, statusBanco }, segredos_impressos: false }))
      throw new FalhaConfiguracao('Função/segredos ainda não estão prontos; nenhum job criado.')
    }
    await sql.begin(async (tx) => {
      await tx.unsafe('create extension if not exists pg_cron; create extension if not exists pg_net with schema extensions')
      // D-079: pg_net guarda o header aberto na fila e seus grants são da plataforma.
      // Conferir a fronteira real, sem tentar revogar grants de supabase_admin.
      const papeis = await tx<{ rolcanlogin: boolean; vault: boolean }[]>`select rolcanlogin,
        has_table_privilege(rolname::text,'vault.decrypted_secrets','select') vault
        from pg_roles where rolname in ('anon','authenticated')`
      if (papeis.length !== 2 || papeis.some((p) => p.rolcanlogin || p.vault)) {
        throw new FalhaConfiguracao('Papéis do app alcançam credenciais do cron; nenhum job criado.')
      }
      const fila = await fetch(`${new URL(api).origin}/rest/v1/http_request_queue?select=id&limit=0`, {
        headers: { apikey: anonima, authorization: `Bearer ${anonima}`, 'accept-profile': 'net' },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
      const limite: unknown = await fila.json()
      if (fila.status !== 406 || typeof limite !== 'object' || limite === null || !('code' in limite) || limite.code !== 'PGRST106') {
        throw new FalhaConfiguracao('Não foi possível confirmar a fila fora da API do app; nenhum job criado.')
      }
      const [fuso] = await tx<{ valor: string | null }[]>`select current_setting('cron.timezone',true) valor`
      if (fuso?.valor && !['UTC', 'GMT', 'Etc/UTC'].includes(fuso.valor)) throw new FalhaConfiguracao('Cron usa outro fuso; conferir antes de agendar.')
      const interno = ambiente === 'local' ? 'http://kong:8000/functions/v1/enviar-lembretes' : endpoint
      const comando = `select net.http_post(url := '${interno}', headers := jsonb_build_object('Content-Type','application/json','Authorization',
        (select 'Bearer ' || (decrypted_secret::jsonb->>'token') from vault.decrypted_secrets where name='${NOME_SEGREDO}')), body := '{}'::jsonb, timeout_milliseconds := 120000);`
      const existentes = await tx<{ command: string; schedule: string; active: boolean }[]>`select command,schedule,active from cron.job where jobname=${NOME_JOB}`
      if (existentes.length) {
        if (existentes.length !== 1 || existentes[0]?.command !== comando || existentes[0]?.schedule !== '0,15,30 12 * * *' || !existentes[0]?.active) {
          throw new FalhaConfiguracao('Job preexistente diferente; preservado para conferência.')
        }
      } else await tx`select cron.schedule(${NOME_JOB},'0,15,30 12 * * *',${comando})`
    })
    console.log('Fronteira conferida: papéis do app sem login SQL/leitura do Vault; net fora da Data API.')
    console.log('Job conferido: 9h, 9h15 e 9h30 em America/Fortaleza. Tentativa não comprova entrega.')
  } finally { await sql.close() }
}

if (import.meta.main) {
  try {
    const acao = process.argv[2]
    if (acao === 'preparar') await prepararConfiguracaoLembretes()
    else if (acao === 'segredos') await mostrarSegredosLembretes()
    else if (acao === 'agendar') await agendarLembretes()
    else throw new FalhaConfiguracao('Use preparar, segredos ou agendar pelo comando do ambiente de teste.')
  } catch (erro) {
    console.error(erro instanceof FalhaConfiguracao ? erro.message : 'Falha na configuração dos lembretes; detalhes sensíveis omitidos.')
    process.exitCode = 1
  }
}
