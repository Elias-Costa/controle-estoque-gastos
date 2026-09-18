import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { uuidv7 } from '../../src/dados/identidade.ts'
import type { ClienteLocal } from '../../src/dados/banco.ts'
import type { Lancamento } from '../../src/dominio/ficha.ts'
import { clienteDaNuvem, clienteParaNuvem, lancamentoDaNuvem, lancamentoParaNuvem } from '../../src/sincronizacao/borda.ts'
import { criarNuvemSupabase, type Falha, type Nuvem, type Resposta } from '../../src/sincronizacao/nuvem.ts'

/**
 * O transporte real (E-07, D-042 item 4): `supabase-js` → PostgREST → o banco dela, com um
 * usuário de teste. O que só se prova aqui, e não com a nuvem de mentira nem por conexão direta
 * ao Postgres: que a borda atravessa o PostgREST inteira (`bigint` como texto com o cast
 * `::text`, `jsonb`, `date`, carimbos), **a forma do erro** que o PostgREST devolve para cada
 * recusa — inclusive o `raise … using constraint` dos gatilhos —, o gatilho de último-que-escreve
 * visto pelo app, e a classificação de sessão e de rede com falhas de verdade.
 *
 * **As linhas que este arquivo cria ficam no banco.** Lançamento é imutável e ninguém apaga (RI-03);
 * elas nascem sob o `dono` do usuário de teste e a RLS as esconde da conta dela. A limpeza é
 * `migrar:reverter` + `migrar` antes de E-15 (`nuvem/LEIA-ME.md`). Cada rodada usa ids novos.
 *
 * Precisa, em `.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_TESTE_EMAIL`,
 * `SUPABASE_TESTE_SENHA` (usuário criado no painel: Authentication → Users → Add user, auto-confirm).
 * Sem eles, a suíte pula e diz por quê — não "passa".
 */

const LIGADA = process.env.INTEGRACAO === '1'
const URL = process.env.VITE_SUPABASE_URL ?? ''
const CHAVE = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const EMAIL = process.env.SUPABASE_TESTE_EMAIL ?? ''
const SENHA = process.env.SUPABASE_TESTE_SENHA ?? ''
const COM_USUARIO = LIGADA && URL !== '' && CHAVE !== '' && EMAIL !== '' && SENHA !== ''

if (LIGADA && !COM_USUARIO) {
  console.warn('testes/integracao/sincronizacao.test.ts pulada: faltam VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_TESTE_EMAIL ou SUPABASE_TESTE_SENHA em .env.local')
}

const GRANDE = 9007199254740993n // 2^53 + 1

let supabase: SupabaseClient
let nuvem: Nuvem

beforeAll(async () => {
  if (!COM_USUARIO) return
  supabase = createClient(URL, CHAVE, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: SENHA })
  if (error) throw new Error(`login do usuário de teste falhou: ${error.message}`)
  nuvem = criarNuvemSupabase(supabase)
})

afterAll(async () => {
  if (COM_USUARIO) await supabase.auth.signOut()
})

function esperarOk<T>(resposta: Resposta<T>): T {
  if (!resposta.ok) throw new Error(`falhou: ${JSON.stringify(resposta.falha)}`)
  return resposta.valor
}

function esperarFalha<T>(resposta: Resposta<T>): Falha {
  if (resposta.ok) throw new Error('a nuvem aceitou o que deveria recusar')
  return resposta.falha
}

/** Um instante um pouco antes de agora, no relógio deste computador: o `desde` das buscas. */
function haPouco(): string {
  return new Date(Date.now() - 5 * 60_000).toISOString()
}

describe.skipIf(!COM_USUARIO)('o transporte real: supabase-js → PostgREST → o banco dela (E-07, D-042)', () => {
  const clienteId = uuidv7()
  const cliente: ClienteLocal = { id: clienteId, nome: 'Vera (teste E-07)', telefone: '(11) 9 8765-4321', atualizadoEm: '2026-09-12T10:05:00.000Z' }
  const venda: Lancamento = {
    tipo: 'venda',
    pagamento: 'fiado',
    id: uuidv7(),
    clienteId,
    data: '2026-09-01',
    itens: [{ descricao: 'perfume', preco: 10000n }, { descricao: 'creme', preco: GRANDE }],
    desconto: 5n,
    parcelas: [{ id: uuidv7(), vencimento: '2026-10-01', valor: GRANDE }, { id: uuidv7(), vencimento: '2026-11-01', valor: 9995n }],
  }
  const recebimento: Lancamento = { tipo: 'recebimento', id: uuidv7(), clienteId, data: '2026-09-05', valor: 5000n, forma: 'dinheiro', observacao: 'na feira' }
  const estorno: Lancamento = { tipo: 'estorno', id: uuidv7(), clienteId, data: '2026-09-06', estornaId: recebimento.id }

  test('há sessão; sem sessão o mesmo envio é falha de sessão, não recusa', async () => {
    expect(await nuvem.temSessao()).toBe(true)
    const anonimo = criarNuvemSupabase(createClient(URL, CHAVE, { auth: { persistSession: false } }))
    expect(await anonimo.temSessao()).toBe(false)
    const falha = esperarFalha(await anonimo.enviarCliente(clienteParaNuvem(cliente)))
    expect(falha.tipo).toBe('sessao')
    console.log('sem sessão, o PostgREST devolveu:', JSON.stringify(falha))
  })

  test('sobe cliente, venda com 2^53+1, recebimento e estorno; desce tudo igual, bigint exato, dinheiro como texto', async () => {
    esperarOk(await nuvem.enviarCliente(clienteParaNuvem(cliente)))
    esperarOk(await nuvem.enviarLancamento(lancamentoParaNuvem(venda)))
    esperarOk(await nuvem.enviarLancamento(lancamentoParaNuvem(recebimento)))
    esperarOk(await nuvem.enviarLancamento(lancamentoParaNuvem(estorno)))

    const clientes = esperarOk(await nuvem.buscarClientes(haPouco()))
    const linhaCliente = clientes.find((linha) => linha['id'] === clienteId)
    if (linhaCliente === undefined) throw new Error('o cliente não desceu')
    expect(clienteDaNuvem(linhaCliente)).toEqual(cliente)
    expect(typeof linhaCliente['recebido_em']).toBe('string')
    console.log('carimbos como o PostgREST devolve:', linhaCliente['atualizado_em'], linhaCliente['recebido_em'])

    const lancamentos = esperarOk(await nuvem.buscarLancamentos(haPouco()))
    const porId = new Map(lancamentos.map((linha) => [String(linha['id']), linha]))
    for (const esperado of [venda, recebimento, estorno]) {
      const linha = porId.get(esperado.id)
      if (linha === undefined) throw new Error(`${esperado.tipo} ${esperado.id} não desceu`)
      expect(lancamentoDaNuvem(linha)).toEqual(esperado)
    }
    // O cast `::text` do select: o dinheiro volta como texto, não como número JSON.
    const linhaVenda = porId.get(venda.id)
    const linhaRecebimento = porId.get(recebimento.id)
    expect(typeof linhaVenda?.['desconto']).toBe('string')
    expect(typeof linhaRecebimento?.['valor']).toBe('string')
    expect(linhaVenda?.['valor']).toBeNull()
    // A ordem é por carimbo do servidor, depois id: a venda subiu antes do recebimento.
    const ids = lancamentos.map((linha) => String(linha['id']))
    expect(ids.indexOf(venda.id)).toBeLessThan(ids.indexOf(recebimento.id))
  })

  test('a marca de fichinha desativada (0003, D-050) sobe como `date`, desce como `Dia`, e sai quando reativa', async () => {
    // Escrito em E-16 sem rodar contra o projeto dela (há dado real; ARCHITECTURE §11): roda no segundo projeto.
    const desativado: ClienteLocal = { ...cliente, desativadoEm: '2026-09-18', atualizadoEm: '2026-09-12T10:06:00.000Z' }
    esperarOk(await nuvem.enviarCliente(clienteParaNuvem(desativado)))
    let linha = esperarOk(await nuvem.buscarClientes(haPouco())).find((l) => l['id'] === clienteId)
    if (linha === undefined) throw new Error('o cliente desativado não desceu')
    expect(linha['desativado_em']).toBe('2026-09-18')
    expect(clienteDaNuvem(linha).desativadoEm).toBe('2026-09-18')

    const reativado: ClienteLocal = { ...cliente, atualizadoEm: '2026-09-12T10:07:00.000Z' }
    esperarOk(await nuvem.enviarCliente(clienteParaNuvem(reativado)))
    linha = esperarOk(await nuvem.buscarClientes(haPouco())).find((l) => l['id'] === clienteId)
    if (linha === undefined) throw new Error('o cliente reativado não desceu')
    expect(linha['desativado_em']).toBeNull()
    expect(clienteDaNuvem(linha)).toEqual(reativado)
  })

  test('RT-08 no transporte real: reenviar idêntico passa; reenviar diferente é recusa 23000 — e a forma do erro fica registrada', async () => {
    esperarOk(await nuvem.enviarLancamento(lancamentoParaNuvem(recebimento)))
    const diferente = esperarFalha(await nuvem.enviarLancamento(lancamentoParaNuvem({ ...recebimento, valor: 4000n })))
    console.log('reenvio diferente, o PostgREST devolveu:', JSON.stringify(diferente))
    expect(diferente.tipo).toBe('recusa')
    if (diferente.tipo !== 'recusa') throw new Error('não é recusa')
    expect(diferente.codigo).toBe('23000')
    expect(diferente.mensagem).toContain('correção é estorno')
  })

  test('segundo estorno do mesmo alvo é 23505 com o nome do índice; cliente inexistente é 23503 com o nome da FK', async () => {
    const segundo = esperarFalha(await nuvem.enviarLancamento(lancamentoParaNuvem({ ...estorno, id: uuidv7() })))
    console.log('segundo estorno, o PostgREST devolveu:', JSON.stringify(segundo))
    expect(segundo).toMatchObject({ tipo: 'recusa', codigo: '23505', constraint: 'lancamentos_um_estorno_por_alvo' })

    const semPai = esperarFalha(await nuvem.enviarLancamento(lancamentoParaNuvem({ ...recebimento, id: uuidv7(), clienteId: uuidv7() })))
    console.log('cliente inexistente, o PostgREST devolveu:', JSON.stringify(semPai))
    expect(semPai).toMatchObject({ tipo: 'recusa', codigo: '23503', constraint: 'lancamentos_cliente' })
  })

  test('último-que-escreve visto pelo app: a versão mais antiga é aceita sem erro e não muda nada; a mais nova muda', async () => {
    esperarOk(await nuvem.enviarCliente(clienteParaNuvem({ ...cliente, nome: 'Vera (mais antiga)', atualizadoEm: '2026-09-12T10:00:00.000Z' })))
    let linha = esperarOk(await nuvem.buscarClientes(haPouco())).find((l) => l['id'] === clienteId)
    expect(linha?.['nome']).toBe('Vera (teste E-07)')
    expect(clienteDaNuvem(linha).atualizadoEm).toBe('2026-09-12T10:05:00.000Z')

    esperarOk(await nuvem.enviarCliente(clienteParaNuvem({ ...cliente, nome: 'Vera (mais nova)', atualizadoEm: '2026-09-12T10:10:00.000Z' })))
    linha = esperarOk(await nuvem.buscarClientes(haPouco())).find((l) => l['id'] === clienteId)
    expect(linha?.['nome']).toBe('Vera (mais nova)')
    expect(clienteDaNuvem(linha).atualizadoEm).toBe('2026-09-12T10:10:00.000Z')
  })

  test('o download desde um carimbo exclui o que chegou antes dele', async () => {
    const futuro = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
    expect(esperarOk(await nuvem.buscarLancamentos(futuro))).toEqual([])
    expect(esperarOk(await nuvem.buscarClientes(futuro))).toEqual([])
  })
})

describe.skipIf(!LIGADA)('falha de rede de verdade: host inalcançável', () => {
  test('o supabase-js devolve erro com code vazio, e a classificação é rede — nunca recusa', async () => {
    const inalcancavel = criarNuvemSupabase(createClient('https://127.0.0.1:1', 'chave-qualquer', { auth: { persistSession: false } }))
    const falha = esperarFalha(await inalcancavel.enviarCliente(clienteParaNuvem({ id: uuidv7(), nome: 'x', atualizadoEm: '2026-09-12T10:00:00.000Z' })))
    console.log('host inalcançável, o supabase-js devolveu:', JSON.stringify(falha))
    expect(falha.tipo).toBe('rede')
    const busca = esperarFalha(await inalcancavel.buscarClientes(null))
    expect(busca.tipo).toBe('rede')
  }, 30_000)
})
