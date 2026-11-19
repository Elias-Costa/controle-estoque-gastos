import { realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { SQL } from 'bun'
import { createClient } from '@supabase/supabase-js'
import { conectar } from '../migrar.ts'
import { exigirDestinoConfiguracaoBackup, validarContaBackup } from './destino.ts'
import { consultarAutorizacaoGoogle, lerAutorizacaoGoogle, registrarAutorizacaoGoogle, SEGREDO_GOOGLE_BACKUP, SEGREDO_GOOGLE_BACKUP_PRODUCAO, type AutorizacaoGoogle } from './cofre-google.ts'
import { abrirRetornoGoogle } from './retorno-google.ts'
import { lerClienteGoogleWeb } from './google-web.ts'
import { consultarContaDrive, criarTentativaGoogle, FalhaGoogle, lerClienteGoogle, PROJETO_GOOGLE_DE_TESTE, PROJETO_GOOGLE_DE_PRODUCAO, renovarTokensGoogle,
  trocarCodigoGoogle, urlAutorizacaoGoogle, type ClienteGoogle, type ContaDrive } from './google.ts'

/** Lê somente o JSON Desktop indicado pelo mantenedor, fora da árvore do repositório. */
export async function lerArquivoClienteGoogle(caminho: string, projeto = PROJETO_GOOGLE_DE_TESTE, web = false): Promise<ClienteGoogle> {
  try {
    if (!isAbsolute(caminho) || extname(caminho).toLowerCase() !== '.json' || basename(caminho).startsWith('.env')) throw new Error()
    const arquivo = await realpath(caminho), raiz = await realpath(resolve(import.meta.dir, '../..'))
    const dentro = relative(raiz, arquivo)
    if (dentro !== '..' && !dentro.startsWith(`..${sep}`) && !isAbsolute(dentro)) throw new Error()
    const fonte = Bun.file(arquivo)
    if (fonte.size > 16_384) throw new Error()
    return web ? lerClienteGoogleWeb(await fonte.json(), projeto === PROJETO_GOOGLE_DE_PRODUCAO) : lerClienteGoogle(await fonte.json(), projeto)
  } catch { throw new FalhaGoogle(`Indique o caminho absoluto do JSON ${web ? 'Web' : 'Desktop'} deste ambiente, guardado fora do repositório; detalhes omitidos.`) }
}

/** D-085: consulta somente o UUID informado no Auth, sem senha ou escolha automática de conta. */
export async function conferirContaFichinhas(sql: SQL, conta: string): Promise<string> {
  const id = validarContaBackup(conta)
  const linhas = await sql<{ email: string | null }[]>`select email from auth.users where id=${id}::uuid`
  const email = linhas[0]?.email
  if (linhas.length !== 1 || !email || email.length > 320 || [...email].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new FalhaGoogle('UUID da conta Fichinhas não localizado com e-mail válido no Auth deste destino.')
  }
  return email
}

/** Conta fictícia do destino D-050; não é usada para selecionar uma conta de produção. */
export async function contaFichinhasDeTeste(): Promise<string> {
  const api = process.env.VITE_SUPABASE_URL, anonima = process.env.VITE_SUPABASE_ANON_KEY
  const email = process.env.SUPABASE_TESTE_EMAIL, senha = process.env.SUPABASE_TESTE_SENHA
  if (!api || !anonima || !email || !senha) throw new FalhaGoogle('Configuração da conta fictícia ausente.')
  const cliente = createClient(api, anonima, { auth: { persistSession: false, autoRefreshToken: false } })
  const login = await cliente.auth.signInWithPassword({ email, password: senha })
  if (login.error || !login.data.user) throw new FalhaGoogle('Não foi possível confirmar a conta fictícia do Fichinhas.')
  return login.data.user.id
}

function conferirVinculo(autorizacao: AutorizacaoGoogle, ambiente: string, contaId: string, destino: string): void {
  if (autorizacao.ambiente !== ambiente || autorizacao.destino !== destino || autorizacao.contaId !== contaId) {
    throw new FalhaGoogle('Autorização guardada pertence a outra conta/ambiente; nenhuma alteração foi feita.')
  }
}
function cotaPublica(conta: ContaDrive) {
  return { usoBytes: String(conta.uso), limiteBytes: conta.limite === undefined ? null : String(conta.limite),
    disponivelBytes: conta.limite === undefined ? null : String(conta.limite > conta.uso ? conta.limite - conta.uso : 0n) }
}

/** Consentimento/contas conferidos antes de guardar no cofre próprio do ambiente. */
export async function configurarGoogle(acao: string | undefined, caminho?: string, producao?: { projeto: string; contaId: string }): Promise<void> {
  const ambiente = exigirDestinoConfiguracaoBackup(producao?.projeto)
  if (!['autorizar', 'reautorizar', 'verificar'].includes(acao ?? '')) throw new FalhaGoogle('Use autorizar, reautorizar ou verificar pelo comando do ambiente escolhido.')
  if (acao !== 'verificar' && (!process.stdout.isTTY || !process.stdin.isTTY || process.platform !== 'win32')) {
    throw new FalhaGoogle('Autorize no seu terminal Windows interativo, sem redirecionar a saída.')
  }
  const contaId = producao ? validarContaBackup(producao.contaId) : await contaFichinhasDeTeste(), destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
  const nome = ambiente === 'producao' ? SEGREDO_GOOGLE_BACKUP_PRODUCAO : SEGREDO_GOOGLE_BACKUP
  const projetoGoogle = ambiente === 'producao' ? PROJETO_GOOGLE_DE_PRODUCAO : PROJETO_GOOGLE_DE_TESTE
  const clienteNovo = acao === 'verificar' ? undefined : caminho ? await lerArquivoClienteGoogle(caminho, projetoGoogle) : undefined
  if (acao !== 'verificar' && !clienteNovo) throw new FalhaGoogle('Informe o caminho absoluto do JSON Desktop, fora do repositório.')
  const sql = conectar()
  try {
    const emailFichinhas = ambiente === 'producao' ? await conferirContaFichinhas(sql, contaId) : undefined
    const [linhaAtiva] = ambiente === 'producao' ? await sql<{ valor: unknown }[]>`select public.obter_autorizacao_backup_producao() valor`
      : await sql<{ valor: unknown }[]>`select public.obter_autorizacao_backup() valor`
    const ativa = linhaAtiva?.valor === null || linhaAtiva?.valor === undefined ? null : lerAutorizacaoGoogle(linhaAtiva.valor)
    if (acao !== 'verificar' && ativa?.formato === 2) throw new FalhaGoogle('A conexão atual foi feita pelo app. Para escolher ou autorizar o Drive, use Cópia das anotações.')
    const anterior = acao === 'verificar' ? ativa : await consultarAutorizacaoGoogle(sql, nome)
    if (anterior) conferirVinculo(anterior, ambiente, contaId, destino)
    if (acao === 'verificar') {
      if (!anterior) throw new FalhaGoogle('Autorize primeiro a conta Google neste ambiente.')
      const token = await renovarTokensGoogle(anterior.cliente, anterior.renovacao)
      const conta = await consultarContaDrive(token.acesso)
      if (conta.id !== anterior.contaGoogleId) throw new FalhaGoogle('A conta Google renovada diverge da autorização guardada.')
      if (token.renovacao && token.renovacao !== anterior.renovacao) {
        if (anterior.vinculoId) await sql`select public.renovar_google_web(${anterior.vinculoId}::uuid,${anterior.renovacao},${token.renovacao})`
        else await sql.begin((tx) => registrarAutorizacaoGoogle(tx, { ...anterior, renovacao: token.renovacao ?? anterior.renovacao }, anterior, nome))
      }
      console.log(JSON.stringify({ ambiente, projetoGoogle, autorizado: true, renovacaoConferida: true, conectadoPeloApp: anterior.formato === 2,
        ...cotaPublica(conta), arquivosEnviados: 0, segredosImpressos: false }))
      return
    }
    if ((acao === 'autorizar' && anterior) || (acao === 'reautorizar' && !anterior)) {
      throw new FalhaGoogle(anterior ? 'Já existe autorização; use verificar ou reautorizar explicitamente.' : 'Não há autorização anterior; use autorizar.')
    }
    if (!clienteNovo) throw new FalhaGoogle('Cliente Desktop não conferido; nada foi guardado.')
    const cliente = clienteNovo
    if (anterior && cliente.clienteId !== anterior.cliente.clienteId) throw new FalhaGoogle('Reautorizar exige o mesmo cliente Desktop; não migra a integração.')
    const tentativa = await criarTentativaGoogle(), retorno = abrirRetornoGoogle(tentativa.estado)
    let codigo: string
    try {
      console.log(ambiente === 'producao'
        ? 'Abrindo o navegador. A usuária deve escolher sua conta Google e autorizar somente os arquivos desta aplicação.'
        : 'Abrindo o navegador. Escolha a conta Google preparada para dados fictícios e autorize somente os arquivos desta aplicação.')
      const navegador = Bun.spawn(['rundll32.exe', 'url.dll,FileProtocolHandler', urlAutorizacaoGoogle(cliente, tentativa, retorno.url)], { stdout: 'ignore', stderr: 'ignore' })
      if (await navegador.exited !== 0) throw new FalhaGoogle('Não foi possível abrir o navegador; nenhuma autorização foi guardada.')
      codigo = await retorno.codigo
    } finally { retorno.fechar() }
    const tokens = await trocarCodigoGoogle(cliente, tentativa, retorno.url, codigo)
    if (!tokens.renovacao) throw new FalhaGoogle('Google não forneceu autorização de renovação; nada foi guardado.')
    const renovado = await renovarTokensGoogle(cliente, tokens.renovacao)
    const conta = await consultarContaDrive(renovado.acesso)
    if (anterior && conta.id !== anterior.contaGoogleId) throw new FalhaGoogle('A conta escolhida é diferente da anterior; nada foi substituído.')
    // A identidade aparece apenas no terminal local; o relatório compartilhável omite e-mail/ids Google.
    console.log(`Conta selecionada no Google: ${conta.email}`)
    console.log(`Destino: ${ambiente}; conta Fichinhas: ${emailFichinhas ? `${emailFichinhas} — ` : ''}${contaId}.`)
    console.log('A autorização será guardada somente no Vault deste servidor. Nenhuma pasta ou arquivo será enviado agora.')
    const entrada = createInterface({ input: process.stdin, output: process.stdout })
    let confirmacao: string
    try { confirmacao = await entrada.question(ambiente === 'producao'
      ? 'Confirma a conta Fichinhas e que o Drive escolhido é o da usuária final? Digite CONFIRMAR: '
      : 'Confirma que esta é a conta Google de teste escolhida? Digite CONFIRMAR: ') }
    finally { entrada.close() }
    if (confirmacao !== 'CONFIRMAR') throw new FalhaGoogle('Não confirmado; a autorização não foi guardada no servidor.')
    const nova: AutorizacaoGoogle = { formato: 1, ambiente, destino, contaId, contaGoogleId: conta.id, cliente,
      renovacao: renovado.renovacao ?? tokens.renovacao, autorizadoEm: new Date().toISOString() }
    await sql.begin((tx) => registrarAutorizacaoGoogle(tx, nova, anterior, nome))
    console.log(JSON.stringify({ ambiente, projetoGoogle, autorizado: true, renovacaoConferida: true,
      ...cotaPublica(conta), arquivosEnviados: 0, segredosImpressos: false }))
  } finally { await sql.close() }
}

if (import.meta.main) {
  try { await configurarGoogle(process.argv[2], process.argv[3]) }
  catch (erro) { console.error(erro instanceof FalhaGoogle ? erro.message : 'Falha na configuração Google; detalhes sensíveis omitidos.'); process.exitCode = 1 }
}
