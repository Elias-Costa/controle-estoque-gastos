import { expect, test } from 'bun:test'
import { criarHandlerLembretes, ErroConfiguracaoEmissor, ErroRpcEmissor, type PortasEmissor } from '../nuvem/lembretes/emissor.ts'
const token = 'a'.repeat(64)
const hashToken = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), (b) => b.toString(16).padStart(2, '0')).join('')
function pedido(corpo = '{}', autorizacao = `Bearer ${token}`, metodo = 'POST') {
  return new Request('https://teste.invalid/functions/v1/lembretes', { method: metodo,
    headers: { authorization: autorizacao }, ...(metodo === 'GET' ? {} : { body: corpo }) })
}
function portas(mudancas: Partial<PortasEmissor> = {}): PortasEmissor {
  return { hashToken, agora: () => '2026-10-31T12:00:00Z', rpc: async () => [], enviar: async () => ({ estado: 'aceito' }), ...mudancas }
}
test('autenticação e corpo são conferidos antes de qualquer acesso ao banco', async () => {
  let acessos = 0
  const handler = criarHandlerLembretes(portas({ rpc: async () => { acessos++; return [] } }))
  for (const [request, codigo] of [[pedido('{}', ''), 401], [pedido('{}', `Bearer ${'b'.repeat(64)}`), 401],
    [pedido('{}', undefined, 'GET'), 405], [pedido('{"conta":"outra"}'), 400], [pedido('x'.repeat(129)), 413]] as const) {
    expect((await handler(request)).status).toBe(codigo)
  }
  expect(acessos).toBe(0)
  expect((await handler(pedido())).status).toBe(200)
  expect(acessos).toBe(1)
})
test('fora da manhã e configuração inválida não iniciam rodadas nem consultam dados', async () => {
  let acessos = 0
  const rpc = async () => { acessos++; return [] }
  expect((await criarHandlerLembretes(portas({ rpc, agora: () => '2026-10-31T23:00:00Z' }))(pedido())).status).toBe(200)
  expect((await criarHandlerLembretes(portas({ rpc, preparar: async () => { throw new Error('Privado') } }))(pedido())).status).toBe(503)
  expect(acessos).toBe(0)
})
test('verificação autenticada confere configuração fora do horário sem abrir rodada ou enviar', async () => {
  const chamadas: string[] = []
  const handler = criarHandlerLembretes(portas({ agora: () => '2026-10-31T23:00:00Z',
    preparar: async () => { chamadas.push('preparar') }, rpc: async (nome) => { chamadas.push(nome); return [] },
    enviar: async () => { throw new Error('Não deveria enviar') } }))
  const resposta = await handler(pedido('{"verificar":true}'))
  expect(await resposta.json()).toEqual({ pronto: true })
  expect(chamadas).toEqual(['preparar', 'listar_contas_lembretes'])
})
test('verificação separa criptografia e acesso ao banco sem expor exceção ou credencial', async () => {
  const criptografia = await criarHandlerLembretes(portas({ preparar: async () => { throw new Error('conteudo-privado') } }))(pedido('{"verificar":true}'))
  expect(await criptografia.json()).toEqual({ erro: 'configuracao_do_emissor' })
  const formato = await criarHandlerLembretes(portas({ preparar: async () => { throw new ErroConfiguracaoEmissor('json_chaves') } }))(pedido('{"verificar":true}'))
  expect(await formato.json()).toEqual({ erro: 'configuracao_do_emissor', etapa: 'json_chaves' })
  const banco = await criarHandlerLembretes(portas({ rpc: async () => { throw new ErroRpcEmissor(403) } }))(pedido('{"verificar":true}'))
  expect(await banco.json()).toEqual({ erro: 'acesso_ao_banco', statusBanco: 403 })
})
test('fotografia malformada não chama emissor ou inicia rodada; erro não revela conteúdo', async () => {
  let envios = 0, reservas = 0
  const handler = criarHandlerLembretes(portas({ rpc: async (nome) => {
    if (nome === 'listar_contas_lembretes') return ['conta']
    if (nome === 'fotografia_lembretes') throw new Error('segredo-do-servidor')
    reservas++; return {}
  }, enviar: async () => { envios++; return { estado: 'aceito' } } }))
  const resposta = await handler(pedido())
  expect(resposta.status).toBe(503)
  expect(await resposta.text()).not.toContain('segredo')
  expect(envios).toBe(0); expect(reservas).toBe(0)
})
test('início confirmado no banco precede transporte e queda é concluída como incerta', async () => {
  const chamadas: string[] = []
  const handler = criarHandlerLembretes(portas({ rpc: async (nome, argumentos) => {
    chamadas.push(nome)
    if (nome === 'listar_contas_lembretes') return ['conta']
    if (nome === 'fotografia_lembretes') return { carimbo: 'a'.repeat(32), observacao: { baixos: [], pendentes: [], lembrados: [] },
      fontes: { clientes: [], lancamentos: [], produtos: [], movimentos: [], evidencias: [], caixa: [] } }
    if (nome === 'preparar_rodada_lembretes') return { destinos: [{ aparelhoId: 'aparelho', revisao: 1, tentativa: 1,
      inscricao: { endpoint: 'https://fcm.googleapis.com/ficticio', p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }] }
    expect(argumentos['resultado']).toBe('incerto'); return null
  }, enviar: async (_inscricao, mensagem) => {
    chamadas.push('transporte')
    expect(Object.keys(JSON.parse(mensagem))).toEqual(['formato', 'dia', 'rodada'])
    throw new Error('resposta perdida')
  } }))
  expect((await handler(pedido())).status).toBe(200)
  expect(chamadas).toEqual(['listar_contas_lembretes', 'fotografia_lembretes', 'preparar_rodada_lembretes', 'transporte', 'concluir_envio_lembretes'])
})
