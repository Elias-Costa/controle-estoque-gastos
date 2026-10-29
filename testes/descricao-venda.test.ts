import { afterEach, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarCorrecaoDescricaoEnvio } from '../src/dados/completar-descricao-envio.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { parcelas, saldo, validar, type VendaFiado } from '../src/dominio/ficha.ts'
import { corrigir, novaVendaAVista, novaVendaFiado, registrarRecebimento } from '../src/dominio/lancamentos.ts'
import { criarItemVendido, prepararCorrecaoVenda, prepararVendaEstoque } from '../src/dominio/vendas-estoque.ts'
import { conferir } from '../src/interface/rascunho-da-venda.ts'
import { fraseDaGuarda } from '../src/interface/palavras-da-venda.ts'
import { item, operacao, produto, venda } from './apoio-estoque.ts'

const GRANDE = 9007199254740993n
const antiga: VendaFiado = { tipo: 'venda', pagamento: 'fiado', id: 'antiga', clienteId: 'cliente', data: '2026-10-20',
  itens: [{ descricao: '', preco: GRANDE }, { descricao: '  ', preco: 0n }, { descricao: ' Nome preservado ', preco: 300n }], desconto: 5n,
  parcelas: [{ id: 'parcela', vencimento: '2026-11-20', valor: GRANDE + 295n }] }
const problema = { codigo: '23514', constraint: 'lancamentos_sem_itens', mensagem: 'Recusa fictícia', em: '2026-10-20T17:16:42.390Z' }
const bancos: BancoLocal[] = []
afterEach(() => { for (const b of bancos.splice(0)) b.close() })

async function preparar() {
  const banco = new BancoLocal('descricao', { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(banco)
  const repo = criarRepositorioLocal(banco, () => '2026-10-20T17:16:41.862Z')
  await repo.gravarCliente({ id: 'cliente', nome: 'Cliente fictícia' })
  // Reproduz registro legado; a nova operação de criação já não aceita esta entrada.
  await repo.gravarLancamento(antiga)
  const fila = await banco.fila.where('registroId').equals(antiga.id).first(); if (!fila) throw new Error('Sem fila')
  await banco.fila.update(fila.ordem, { problema })
  let avisos = 0
  const correcao = criarCorrecaoDescricaoEnvio(banco, () => { avisos++ })
  const [retrato] = await correcao.ler(); if (!retrato) throw new Error('Sem venda para completar')
  return { banco, correcao, retrato, avisos: () => avisos }
}
async function base(banco: BancoLocal) {
  return Promise.all(banco.tables.map(async (t) => [t.name, await t.toArray()] as const))
}

test('D-078 preço sem descrição trava no rascunho; vazio inteiro continua ignorado e item grátis exige nome', () => {
  const rascunho = { itens: [{ descricao: ' ', precoTexto: '10,00' }, { descricao: '', precoTexto: '' }], pagamento: 'fiado' as const, forma: 'dinheiro' as const, vezes: 1, edicoes: [], data: '2026-10-20', descontoTexto: '' }
  expect(conferir(rascunho, rascunho.data).guardas).toEqual(['falta-descricao'])
  expect(fraseDaGuarda('falta-descricao', 0n, 1000n)).toBe('Informe o que foi vendido em cada item')
  expect(conferir({ ...rascunho, itens: [{ descricao: 'Batom', precoTexto: '10,00' }, { descricao: '', precoTexto: '' }] }, rascunho.data).guardas).toEqual([])
  expect(conferir({ ...rascunho, itens: [{ descricao: 'Batom', precoTexto: '10,00' }, { descricao: '', precoTexto: '0,00' }] }, rascunho.data).guardas).toEqual(['falta-descricao'])
})

test('D-078 domínio recusa criação/correção F1 e F2 sem descrição, inclusive contornando o construtor do item', () => {
  const recusa = { ok: false, motivo: 'item-sem-descricao' } as const
  expect(novaVendaFiado(antiga)).toEqual(recusa)
  expect(novaVendaAVista({ ...antiga, forma: 'dinheiro' })).toEqual(recusa)
  expect(corrigir([antiga], antiga, { sincronizado: false })).toEqual(recusa)
  expect(criarItemVendido({ id: 'item', descricao: '  ', quantidade: 1, precoUnitario: 0n })).toEqual(recusa)
  const original = venda(), semNome = { ...original, itens: [{ ...item(), descricao: '' }] }
  expect(prepararVendaEstoque([], [], semNome, operacao('venda'), [produto], [])).toEqual(recusa)
  expect(prepararCorrecaoVenda([original], [], original, semNome, { operacao: operacao('correcao'), sincronizado: false, revisaoOriginal: 1, natureza: 'financeira', entregas: [], data: original.data })).toEqual(recusa)
})

test('D-078 histórico sem descrição continua legível e aceita recebimento, sem reescrever a venda', () => {
  expect(validar([antiga]).ok).toBe(true)
  expect(saldo([antiga])).toBe(GRANDE + 295n)
  const resultado = registrarRecebimento([antiga], { id: 'recebimento', clienteId: antiga.clienteId, data: antiga.data, valor: 100n, forma: 'pix' })
  if (!resultado.ok) throw new Error(resultado.motivo)
  expect(saldo([antiga, resultado.valor.recebimento])).toBe(GRANDE + 195n)
  expect(parcelas([antiga, resultado.valor.recebimento])[0]?.pago).toBe(100n)
  expect(antiga.itens[0]?.descricao).toBe('')
})

test('D-078 leitura/campo vazio não escrevem; completar só nomes mantém o financeiro e a identidade exatos', async () => {
  const { banco, correcao, retrato, avisos } = await preparar()
  const antes = await base(banco)
  expect(await correcao.ler()).toEqual([retrato]); expect(await base(banco)).toEqual(antes)
  expect(await correcao.completar(retrato, { 0: 'Batom', 1: ' ' })).toEqual({ ok: false, motivo: 'falta-descricao' })
  expect(await base(banco)).toEqual(antes); expect(avisos()).toBe(0)
  const esperado = { ...antiga, itens: [{ ...antiga.itens[0]!, descricao: 'Batom' }, { ...antiga.itens[1]!, descricao: 'Brinde' }, antiga.itens[2]!] }
  expect(await correcao.completar(retrato, { 0: ' Batom ', 1: 'Brinde', 2: 'Não sobrescrever' })).toEqual({ ok: true })
  expect(await banco.lancamentos.get(antiga.id)).toEqual(esperado)
  expect(await banco.fila.get(retrato.fila.ordem)).toEqual({ ...retrato.fila, versao: 1, problema: undefined })
  expect(saldo([esperado])).toBe(saldo([antiga])); expect(parcelas([esperado])).toEqual(parcelas([antiga]).map((p) => ({ ...p, debito: esperado })))
  expect(avisos()).toBe(1)
  const depois = await base(banco)
  expect(await correcao.completar(retrato, { 0: 'Batom', 1: 'Brinde' })).toEqual({ ok: false, motivo: 'mudou' })
  expect(await base(banco)).toEqual(depois); expect(avisos()).toBe(1)
  for (const [nome, linhas] of antes) if (nome !== 'lancamentos' && nome !== 'fila') expect(await banco.table(String(nome)).toArray()).toEqual(linhas)
})

for (const mudanca of ['versao', 'diagnostico', 'conteudo', 'sem-fila', 'grupo'] as const) {
  test(`D-078 não completa retrato desatualizado: ${mudanca}`, async () => {
    const { banco, correcao, retrato, avisos } = await preparar()
    if (mudanca === 'versao') await banco.fila.update(retrato.fila.ordem, { versao: 1 })
    if (mudanca === 'diagnostico') await banco.fila.update(retrato.fila.ordem, { problema: { ...problema, em: '2026-10-21T00:00:00.000Z' } })
    if (mudanca === 'conteudo') await banco.lancamentos.put({ ...antiga, data: '2026-10-19' })
    if (mudanca === 'sem-fila') await banco.fila.delete(retrato.fila.ordem)
    if (mudanca === 'grupo') await banco.operacoes.put({ ...operacao('grupo'), versaoId: 'versao', formato: 1, tipo: 'venda', lancamentos: [{ id: antiga.id, revisao: 1 }], movimentos: [] })
    const antes = await base(banco)
    expect(await correcao.completar(retrato, { 0: 'Batom', 1: 'Brinde' })).toEqual({ ok: false, motivo: 'mudou' })
    expect(await base(banco)).toEqual(antes); expect(avisos()).toBe(0)
  })
}

test('D-078 falha depois do put financeiro reverte nomes e fila inteiros', async () => {
  const { banco, correcao, retrato, avisos } = await preparar()
  const antes = await base(banco)
  const abortar = () => { throw new Error('Falha fictícia da fila') }
  banco.fila.hook('updating', abortar)
  try { await expect(correcao.completar(retrato, { 0: 'Batom', 1: 'Brinde' })).rejects.toThrow('Falha fictícia da fila') }
  finally { banco.fila.hook('updating').unsubscribe(abortar) }
  expect(await base(banco)).toEqual(antes); expect(avisos()).toBe(0)
})

test('D-078 não oferece complemento para outra recusa, F2, lista vazia, item nomeado ou outro erro financeiro', async () => {
  const { banco, correcao, retrato } = await preparar()
  await banco.fila.update(retrato.fila.ordem, { problema: { ...problema, constraint: 'outra' } })
  expect(await correcao.ler()).toEqual([])
  await banco.fila.update(retrato.fila.ordem, { problema })
  for (const registro of [venda(antiga.id), { ...antiga, itens: [] }, { ...antiga, itens: antiga.itens.map((i) => ({ ...i, descricao: 'Nome' })) },
    { ...antiga, desconto: -1n }, { ...antiga, parcelas: [{ ...antiga.parcelas[0]!, valor: 1n }] }, { ...antiga, itens: [{ descricao: '', preco: -1n }] }]) {
    await banco.lancamentos.put(registro)
    const antes = await base(banco)
    expect(await correcao.ler()).toEqual([]); expect(await base(banco)).toEqual(antes)
  }
})
