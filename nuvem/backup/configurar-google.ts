import { realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { createClient } from '@supabase/supabase-js'
import { conectar } from '../migrar.ts'
import { exigirDestinoDeTeste } from '../ambiente-de-teste.ts'
import { consultarAutorizacaoGoogle, registrarAutorizacaoGoogle, type AutorizacaoGoogle } from './cofre-google.ts'
import { abrirRetornoGoogle } from './retorno-google.ts'
import { consultarContaDrive, criarTentativaGoogle, FalhaGoogle, lerClienteGoogle, PROJETO_GOOGLE_DE_TESTE, renovarTokensGoogle,
  trocarCodigoGoogle, urlAutorizacaoGoogle, type ClienteGoogle, type ContaDrive } from './google.ts'

/** Lê somente o JSON Desktop indicado pelo mantenedor, fora da árvore do repositório. */
export async function lerArquivoClienteGoogle(caminho: string): Promise<ClienteGoogle> {
  try {
    if (!isAbsolute(caminho) || extname(caminho).toLowerCase() !== '.json' || basename(caminho).startsWith('.env')) throw new Error()
    const arquivo = await realpath(caminho), raiz = await realpath(resolve(import.meta.dir, '../..'))
    const dentro = relative(raiz, arquivo)
    if (dentro !== '..' && !dentro.startsWith(`..${sep}`) && !isAbsolute(dentro)) throw new Error()
    const fonte = Bun.file(arquivo)
    if (fonte.size > 16_384) throw new Error()
    return lerClienteGoogle(await fonte.json())
  } catch { throw new FalhaGoogle('Indique o caminho absoluto do JSON Desktop de teste, guardado fora do repositório; detalhes omitidos.') }
}

async function contaFichinhas(): Promise<string> {
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

/** Configuração interativa de teste, com consentimento/conta conferidos antes de guardar no Vault. */
export async function configurarGoogle(acao: string | undefined, caminho?: string): Promise<void> {
  const ambiente = exigirDestinoDeTeste()
  if (!['autorizar', 'reautorizar', 'verificar'].includes(acao ?? '')) throw new FalhaGoogle('Use autorizar, reautorizar ou verificar pelo comando do ambiente de teste.')
  if (acao !== 'verificar' && (!process.stdout.isTTY || !process.stdin.isTTY || process.platform !== 'win32')) {
    throw new FalhaGoogle('Autorize no seu terminal Windows interativo, sem redirecionar a saída.')
  }
  const contaId = await contaFichinhas(), destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
  const sql = conectar()
  try {
    const anterior = await consultarAutorizacaoGoogle(sql)
    if (anterior) conferirVinculo(anterior, ambiente, contaId, destino)
    if (acao === 'verificar') {
      if (!anterior) throw new FalhaGoogle('Autorize primeiro a conta Google neste ambiente.')
      const token = await renovarTokensGoogle(anterior.cliente, anterior.renovacao)
      const conta = await consultarContaDrive(token.acesso)
      if (conta.id !== anterior.contaGoogleId) throw new FalhaGoogle('A conta Google renovada diverge da autorização guardada.')
      if (token.renovacao && token.renovacao !== anterior.renovacao) {
        await sql.begin((tx) => registrarAutorizacaoGoogle(tx, { ...anterior, renovacao: token.renovacao ?? anterior.renovacao }, anterior))
      }
      console.log(JSON.stringify({ ambiente, projetoGoogle: PROJETO_GOOGLE_DE_TESTE, autorizado: true, renovacaoConferida: true,
        ...cotaPublica(conta), arquivosEnviados: 0, segredosImpressos: false }))
      return
    }
    if ((acao === 'autorizar' && anterior) || (acao === 'reautorizar' && !anterior)) {
      throw new FalhaGoogle(anterior ? 'Já existe autorização; use verificar ou reautorizar explicitamente.' : 'Não há autorização anterior; use autorizar.')
    }
    if (!caminho) throw new FalhaGoogle('Informe o caminho absoluto do JSON Desktop, fora do repositório.')
    const cliente = await lerArquivoClienteGoogle(caminho)
    if (anterior && cliente.clienteId !== anterior.cliente.clienteId) throw new FalhaGoogle('Reautorizar exige o mesmo cliente Desktop; não migra a integração.')
    const tentativa = await criarTentativaGoogle(), retorno = abrirRetornoGoogle(tentativa.estado)
    let codigo: string
    try {
      console.log('Abrindo o navegador. Escolha a conta Google preparada para dados fictícios e autorize somente os arquivos desta aplicação.')
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
    console.log(`Destino: ${ambiente}; conta fictícia do Fichinhas: ${contaId}.`)
    console.log('A autorização será guardada somente no Vault deste servidor. Nenhuma pasta ou arquivo será enviado agora.')
    const entrada = createInterface({ input: process.stdin, output: process.stdout })
    let confirmacao: string
    try { confirmacao = await entrada.question('Confirma que esta é a conta Google de teste escolhida? Digite CONFIRMAR: ') }
    finally { entrada.close() }
    if (confirmacao !== 'CONFIRMAR') throw new FalhaGoogle('Não confirmado; a autorização não foi guardada no servidor.')
    const nova: AutorizacaoGoogle = { formato: 1, ambiente, destino, contaId, contaGoogleId: conta.id, cliente,
      renovacao: renovado.renovacao ?? tokens.renovacao, autorizadoEm: new Date().toISOString() }
    await sql.begin((tx) => registrarAutorizacaoGoogle(tx, nova, anterior))
    console.log(JSON.stringify({ ambiente, projetoGoogle: PROJETO_GOOGLE_DE_TESTE, autorizado: true, renovacaoConferida: true,
      ...cotaPublica(conta), arquivosEnviados: 0, segredosImpressos: false }))
  } finally { await sql.close() }
}

if (import.meta.main) {
  try { await configurarGoogle(process.argv[2], process.argv[3]) }
  catch (erro) { console.error(erro instanceof FalhaGoogle ? erro.message : 'Falha na configuração Google; detalhes sensíveis omitidos.'); process.exitCode = 1 }
}
