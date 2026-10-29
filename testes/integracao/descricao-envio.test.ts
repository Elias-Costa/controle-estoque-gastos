import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { criarCorrecaoDescricaoEnvio } from '../../src/dados/completar-descricao-envio.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarRepositorioLocal } from '../../src/dados/repositorio.ts'
import { saldo, type VendaFiado } from '../../src/dominio/ficha.ts'
import { lancamentoParaNuvem } from '../../src/sincronizacao/borda.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let cliente: SupabaseClient, nuvem: Nuvem
const bancos: BancoLocal[] = []
beforeAll(async () => {
  if (!LIGADA) return
  cliente = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw new Error('Não foi possível entrar na conta fictícia da integração D-078')
  const { fotos: _fotos, ...metadados } = criarNuvemSupabase(cliente)
  nuvem = metadados
})
afterAll(async () => { for (const b of bancos) b.close(); if (LIGADA) await cliente.auth.signOut() })

function aparelho() {
  const banco = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(banco)
  return { banco, repo: criarRepositorioLocal(banco), correcao: criarCorrecaoDescricaoEnvio(banco) }
}
async function ciclo(banco: BancoLocal, transporte = nuvem) {
  const motor = iniciarSincronizacao({ banco, nuvem: transporte, agendar: () => () => undefined, janela: null, documento: null })
  try { await motor.sincronizar(); return motor.estado() } finally { motor.parar() }
}
async function legado() {
  const a = aparelho(), clienteId = uuidv7(), valor = 9007199254740993n
  await a.repo.gravarCliente({ id: clienteId, nome: `Cliente fictícia D-078 ${uuidv7()}` })
  const venda: VendaFiado = { tipo: 'venda', pagamento: 'fiado', id: uuidv7(), clienteId, data: '2026-10-20', itens: [{ descricao: '', preco: valor }], desconto: 0n,
    parcelas: [{ id: uuidv7(), vencimento: '2026-11-20', valor }] }
  await a.repo.gravarLancamento(venda)
  return { ...a, venda }
}

describe.skipIf(!LIGADA)('D-078 recuperação específica pelo motor e PostgREST reais', () => {
  test('recusa real, complemento, resposta perdida, reenvio idempotente e restauração mantêm a mesma dívida', async () => {
    const a = await legado()
    expect((await ciclo(a.banco)).comProblema).toBe(1)
    const [retrato] = await a.correcao.ler(); if (!retrato) throw new Error('A recusa real não foi reconhecida')
    expect(retrato.fila.problema).toMatchObject({ codigo: '23514', constraint: 'lancamentos_sem_itens' })
    expect(await a.correcao.completar(retrato, { 0: 'Batom fictício' })).toEqual({ ok: true })
    const esperada = { ...a.venda, itens: [{ ...a.venda.itens[0]!, descricao: 'Batom fictício' }] }
    let perdeu = false, respostaDisponivel = false, envios = 0
    const transporte: Nuvem = { ...nuvem, enviarLancamento: async (linha) => {
      const resposta = await nuvem.enviarLancamento(linha)
      if (linha.id === esperada.id && resposta.ok) {
        envios++
        if (!respostaDisponivel) { perdeu = true; return { ok: false, falha: { tipo: 'rede', mensagem: 'Resposta perdida depois do aceite real' } } }
      }
      return resposta
    } }
    await ciclo(a.banco, transporte)
    expect(perdeu).toBe(true)
    expect(await a.banco.fila.where('registroId').equals(a.venda.id).count()).toBe(1)
    respostaDisponivel = true
    expect((await ciclo(a.banco, transporte)).comProblema).toBe(0)
    expect(envios).toBeGreaterThanOrEqual(2)
    expect(await a.banco.fila.where('registroId').equals(a.venda.id).count()).toBe(0)
    expect(await a.banco.lancamentos.get(a.venda.id)).toEqual(esperada)
    const remoto = await cliente.from('lancamentos').select('id').eq('id', a.venda.id)
    expect(remoto.error).toBeNull(); expect(remoto.data).toEqual([{ id: a.venda.id }])
    const restaurado = aparelho(); await ciclo(restaurado.banco)
    expect(await restaurado.banco.lancamentos.get(a.venda.id)).toEqual(esperada)
    expect(saldo((await restaurado.repo.lerFicha(a.venda.clienteId)))).toBe(saldo([a.venda]))
    expect(await restaurado.banco.fila.count()).toBe(0)
  }, 60_000)

  test('mesmo id já aceito com outro conteúdo continua protegido; complemento não altera o financeiro remoto', async () => {
    const a = await legado(), cadastro = await a.banco.clientes.get(a.venda.clienteId)
    if (!cadastro) throw new Error('Sem cliente fictícia')
    expect((await nuvem.enviarCliente({ id: cadastro.id, nome: cadastro.nome, telefone: null, apelido: null, observacao: null, desativado_em: null, atualizado_em: cadastro.atualizadoEm })).ok).toBe(true)
    const aceita = { ...a.venda, itens: [{ ...a.venda.itens[0]!, descricao: 'Descrição já aceita' }] }
    expect((await nuvem.enviarLancamento(lancamentoParaNuvem(aceita))).ok).toBe(true)
    await ciclo(a.banco)
    const [retrato] = await a.correcao.ler(); if (!retrato) throw new Error('Sem tentativa recusada')
    expect(await a.correcao.completar(retrato, { 0: 'Outra descrição' })).toEqual({ ok: true })
    await ciclo(a.banco)
    expect((await a.banco.fila.where('registroId').equals(a.venda.id).first())?.problema).toMatchObject({ codigo: '23000', mensagem: expect.stringContaining('outro conteúdo') })
    expect(await a.correcao.ler()).toEqual([])
    const restaurado = aparelho(); await ciclo(restaurado.banco)
    expect(await restaurado.banco.lancamentos.get(a.venda.id)).toEqual(aceita)
    expect(saldo(await restaurado.repo.lerFicha(a.venda.clienteId))).toBe(saldo([a.venda]))
  }, 60_000)
})
