import { createClient } from '@supabase/supabase-js'
import { exigirDestinoDeTeste } from '../nuvem/ambiente-de-teste.ts'
import { PROJETO_DE_HOMOLOGACAO } from '../nuvem/destinos-de-teste.ts'

// D-050: o local não herda credenciais de produção, mesmo que o shell já as tenha carregado.
const CAMPOS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_DB_URL', 'SUPABASE_TESTE_EMAIL', 'SUPABASE_TESTE_SENHA']
const EMAIL_LOCAL = 'teste-local@example.test'
const SENHA_LOCAL = 'SomenteTesteLocal123!'
const REDE_LOCAL = 'supabase_teste_controle-estoque-gastos'

async function prepararRedeLocal(): Promise<void> {
  const consulta = Bun.spawn(['docker', 'network', 'inspect', REDE_LOCAL, '--format', '{{json .Options}}'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const [saida] = await Promise.all([new Response(consulta.stdout).text(), new Response(consulta.stderr).text()])
  if (await consulta.exited === 0) {
    const opcoes: unknown = JSON.parse(saida)
    if (typeof opcoes !== 'object' || opcoes === null || Reflect.get(opcoes, 'com.docker.network.bridge.host_binding_ipv4') !== '127.0.0.1') {
      throw new Error(`A rede ${REDE_LOCAL} já existe sem preferência de vínculo ao loopback; confira sua configuração antes de iniciar.`)
    }
    return
  }
  const criacao = Bun.spawn(['docker', 'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', REDE_LOCAL], {
    stdout: 'pipe', stderr: 'inherit',
  })
  await new Response(criacao.stdout).text()
  if (await criacao.exited !== 0) throw new Error('Não foi possível preparar a rede Docker exclusiva dos testes locais.')
}

async function executar(argumentos: string[]): Promise<void> {
  const processo = Bun.spawn([process.execPath, '--no-env-file', ...argumentos], {
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env,
  })
  const codigo = await processo.exited
  if (codigo !== 0) throw new Error(`Comando ${argumentos[0]} terminou com código ${codigo}.`)
}

async function cli(argumentos: string[]): Promise<string> {
  const processo = Bun.spawn([process.execPath, '--no-env-file', 'x', '--no-install', 'supabase', '--network-id', REDE_LOCAL, ...argumentos], {
    stdout: 'pipe', stderr: 'inherit', env: process.env,
  })
  const saida = await new Response(processo.stdout).text()
  if (await processo.exited !== 0) throw new Error('A CLI local falhou. Confira o Docker e a mensagem acima.')
  // status/start podem devolver chaves administrativas locais; elas ficam só na memória.
  return saida
}

function textoNoStatus(status: unknown, campo: string): string {
  if (typeof status !== 'object' || status === null || !(campo in status)) {
    throw new Error(`A CLI não devolveu ${campo}; confira se o Supabase local está iniciado.`)
  }
  const valor: unknown = Reflect.get(status, campo)
  if (typeof valor !== 'string' || valor === '') throw new Error(`Campo ${campo} ausente no status local.`)
  return valor
}

async function configurarLocal(): Promise<void> {
  const status: unknown = JSON.parse(await cli(['status', '--output', 'json']))
  process.env.VITE_SUPABASE_URL = textoNoStatus(status, 'API_URL')
  process.env.SUPABASE_DB_URL = textoNoStatus(status, 'DB_URL')
  process.env.VITE_SUPABASE_ANON_KEY = textoNoStatus(status, 'ANON_KEY')
  process.env.SUPABASE_TESTE_EMAIL = EMAIL_LOCAL
  process.env.SUPABASE_TESTE_SENHA = SENHA_LOCAL
  exigirDestinoDeTeste()

  const admin = createClient(process.env.VITE_SUPABASE_URL, textoNoStatus(status, 'SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // Login primeiro permite repetir as suítes sem alterar nem apagar os dados fictícios existentes.
  const usuario = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const login = await usuario.auth.signInWithPassword({ email: EMAIL_LOCAL, password: SENHA_LOCAL })
  if (login.error) {
    if (login.error.code !== 'invalid_credentials') throw new Error('Não foi possível entrar na conta de teste local.')
    const criado = await admin.auth.admin.createUser({ email: EMAIL_LOCAL, password: SENHA_LOCAL, email_confirm: true })
    if (criado.error) throw new Error('Não foi possível criar a conta fictícia local; confira o serviço Auth local.')
  } else {
    await usuario.auth.signOut()
  }
}

async function configurarHomologacao(): Promise<void> {
  if (PROJETO_DE_HOMOLOGACAO === null) {
    throw new Error('Homologação bloqueada: aguarda criação e confirmação do projeto pelo mantenedor em nuvem/destinos-de-teste.ts.')
  }
  // O processo filho carrega SOMENTE este arquivo. O agente não o lê ou escreve (AGENTS.md §2).
  if (process.argv[4] !== '--configurada') {
    for (const campo of CAMPOS) delete process.env[campo]
    await executar(['--env-file=.env.homologacao.local', 'run', 'ferramentas/testar-ambiente.ts', 'homologacao', process.argv[3] ?? '', '--configurada'])
    process.exit(0)
  }
  exigirDestinoDeTeste()
  for (const campo of CAMPOS) {
    if (!process.env[campo]) throw new Error(`Falta ${campo} na configuração própria de homologação.`)
  }
}

async function principal(): Promise<void> {
  const ambiente = process.argv[2]
  const acao = process.argv[3]
  if (!['local', 'homologacao'].includes(ambiente ?? '') || !['iniciar', 'parar', 'migrar', 'reverter', 'integracao', 'navegador', 'build'].includes(acao ?? '')) {
    throw new Error('Use local ou homologacao e uma ação: iniciar, parar, migrar, reverter, integracao, navegador ou build.')
  }
  process.env.AMBIENTE_DE_TESTE = ambiente
  process.env.LAN = ''
  process.env.INTEGRACAO = ''
  process.env.VITE_LABORATORIO = ''
  if (ambiente === 'local') {
    for (const campo of CAMPOS) delete process.env[campo]
    if (acao === 'iniciar' || acao === 'parar') {
      if (acao === 'iniciar') await prepararRedeLocal()
      await cli([acao === 'iniciar' ? 'start' : 'stop'])
      console.log(acao === 'iniciar' ? 'Supabase local iniciado; nenhuma conexão com a produção.' : 'Supabase local parado; dados fictícios preservados.')
      return
    }
    await configurarLocal()
  } else {
    if (acao === 'iniciar' || acao === 'parar') throw new Error('Iniciar e parar são ações exclusivas do Docker local.')
    await configurarHomologacao()
  }
  console.log(`Ambiente validado: ${ambiente}.`)
  if (acao === 'reverter') {
    await executar(['run', 'nuvem/migrar.ts', 'reverter'])
    return
  }
  // Integração e navegador sempre recebem todas as migrations do mesmo runner, sem reset.
  await executar(['run', 'nuvem/migrar.ts'])
  if (acao === 'migrar') return
  await executar(['run', 'typecheck'])
  if (acao === 'integracao') {
    process.env.INTEGRACAO = '1'
    await executar(['test', '--timeout', '60000', 'testes/integracao'])
    return
  }
  process.env.VITE_LABORATORIO = '1'
  await executar(['x', '--no-install', 'vite', 'build', '--outDir', 'dist-laboratorio'])
  if (acao === 'navegador') await executar(['x', '--no-install', 'playwright', 'test'])
}

if (import.meta.main) {
  try {
    await principal()
  } catch (erro) {
    console.error(erro instanceof Error ? erro.message : 'Falha na preparação do ambiente de teste.')
    process.exitCode = 1
  }
}
