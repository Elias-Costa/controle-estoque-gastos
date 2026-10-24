import { expect, test } from 'bun:test'
import type { EstadoLocalCaixa } from '../src/dados/repositorio-caixa.ts'
import type { Despesa } from '../src/dominio/gastos.ts'
import { linhasDoCaixa } from '../src/interface/leitura-do-caixa.ts'
import { conferirCaixa, rascunhoDoCaixa } from '../src/interface/rascunho-do-caixa.ts'

const gasto: Despesa = { id: 'gasto', revisao: 2, tipo: 'despesa', valor: 9007199254740993n, data: '2026-09-30',
  categoria: 'Grafia livre çã!', classificacao: 'negocio', mercadoria: true }

test('rascunho mantém centavos grandes exatos, categoria livre e mercadoria independente da grafia', () => {
  const r = rascunhoDoCaixa(gasto)
  expect(r.valorTexto).toBe('90.071.992.547.409,93')
  expect(conferirCaixa(r, 'despesa', '2026-10-24')).toEqual({ ok: true, valor: {
    tipo: 'despesa', valor: gasto.valor, data: gasto.data, categoria: gasto.categoria, classificacao: 'negocio', mercadoria: true,
  } })
  expect(conferirCaixa({ ...r, categoria: '  outra  ', mercadoria: false }, 'despesa', '2026-10-24')).toEqual({ ok: true, valor: {
    tipo: 'despesa', valor: gasto.valor, data: gasto.data, categoria: 'outra', classificacao: 'negocio', mercadoria: false,
  } })
  expect(rascunhoDoCaixa(undefined, '2026-10-24')).toEqual({ valorTexto: '', data: '2026-10-24', categoria: '', classificacao: '', mercadoria: false })
})

test('formulário recusa ausência, zero, calendário impossível/futuro e mercadoria pessoal', () => {
  const r = rascunhoDoCaixa(gasto)
  for (const valorTexto of ['', '0,00', 'texto']) expect(conferirCaixa({ ...r, valorTexto }, 'despesa', '2026-10-24')).toEqual({ ok: false, motivo: 'valor-invalido' })
  for (const data of ['', '2026-02-30', '2026-13-01', 'ontem', '2026-10-25']) expect(conferirCaixa({ ...r, data }, 'despesa', '2026-10-24')).toEqual({ ok: false, motivo: 'data-invalida' })
  expect(conferirCaixa({ ...r, categoria: ' ' }, 'despesa', '2026-10-24')).toEqual({ ok: false, motivo: 'categoria-obrigatoria' })
  expect(conferirCaixa({ ...r, classificacao: '' }, 'despesa', '2026-10-24')).toEqual({ ok: false, motivo: 'classificacao-invalida' })
  expect(conferirCaixa({ ...r, classificacao: 'pessoal' }, 'despesa', '2026-10-24')).toEqual({ ok: false, motivo: 'mercadoria-invalida' })
  expect(conferirCaixa({ ...r, data: '2024-02-29', classificacao: 'pessoal' }, 'receita-avulsa', '2026-10-24')).toEqual({ ok: true, valor: {
    tipo: 'receita-avulsa', data: '2024-02-29', categoria: gasto.categoria, valor: gasto.valor, classificacao: 'pessoal',
  } })
})

function estado(): EstadoLocalCaixa {
  return { fatos: [gasto, { tipo: 'receita-avulsa', id: 'receita', revisao: 1, valor: 123n, data: '2026-09-01', categoria: 'Outra', classificacao: 'pessoal' }],
    clientes: [{ id: 'cliente', nome: 'Ficha desativada', desativadoEm: '2026-10-01' }], versoes: [], lancamentos: [
      { tipo: 'venda', pagamento: 'avista', forma: 'pix', id: 'venda', clienteId: 'cliente', data: '2026-09-29', itens: [{ descricao: 'Item', preco: 1100n }], desconto: 100n },
      { tipo: 'venda', pagamento: 'fiado', id: 'fiado', clienteId: 'cliente', data: '2026-09-29', itens: [{ descricao: 'Item', preco: 9999n }], desconto: 0n, parcelas: [{ id: 'parcela', valor: 9999n, vencimento: '2026-10-29' }] },
      { tipo: 'recebimento', id: 'recebimento', clienteId: 'cliente', data: '2026-09-30', valor: 500n, forma: 'dinheiro' },
    ] }
}

test('lista inclui fontes uma vez com valor praticado e ficha desativada; cortes não mudam a natureza', () => {
  const e = estado(), antes = structuredClone(e), tudo = linhasDoCaixa(e, '2026-09', 'tudo')
  expect(tudo.map((l) => [l.id, l.valor, l.direcao])).toEqual([
    ['gasto', gasto.valor, 'saida'], ['recebimento', 500n, 'entrada'], ['venda', 1000n, 'entrada'], ['receita', 123n, 'entrada'],
  ])
  expect(tudo.find((l) => l.id === 'venda')?.detalhe).toBe('Ficha desativada')
  expect(tudo.filter((l) => l.fato).map((l) => l.id)).toEqual(['gasto', 'receita'])
  expect(linhasDoCaixa(e, '2026-09', 'pessoal').map((l) => l.id)).toEqual(['receita'])
  expect(linhasDoCaixa(e, '2026-09', 'negocio').map((l) => l.id)).toEqual(['gasto', 'recebimento', 'venda'])
  expect(linhasDoCaixa(e, '2026-10', 'tudo')).toEqual([])
  expect(e).toEqual(antes)
})

test('estornos de outro mês retiram alvos originais da lista, sem representar movimento em outubro', () => {
  const e = estado()
  const corrigido: EstadoLocalCaixa = { ...e, fatos: [...e.fatos, { tipo: 'estorno', id: 'estorno', revisao: 1, data: '2026-10-24', alvo: gasto }],
    lancamentos: [...e.lancamentos, { tipo: 'estorno', id: 'estorno-ficha', clienteId: 'cliente', data: '2026-10-24', estornaId: 'recebimento' }] }
  expect(linhasDoCaixa(corrigido, '2026-09', 'tudo').map((l) => l.id)).toEqual(['venda', 'receita'])
  expect(linhasDoCaixa(corrigido, '2026-10', 'tudo')).toEqual([])
})
