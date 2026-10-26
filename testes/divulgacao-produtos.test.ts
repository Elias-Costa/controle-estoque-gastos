import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarLeituraDivulgacao, type RetratoDivulgacao } from '../src/dados/leitura-divulgacao.ts'
import { chaveDaMarca, filtrarDivulgacao, itensPdfDivulgacao, mesmasLinhasDivulgacao, relerPreviaDivulgacao, type FiltrosDivulgacao, type PreviaDivulgacao } from '../src/interface/divulgacao-produtos.ts'
import { prepararDivulgacao } from '../src/interface/preparar-divulgacao.ts'
import { compra, item, venda, ok } from './apoio-estoque.ts'
import { novaContagem } from '../src/dominio/estoque.ts'

const filtros: FiltrosDivulgacao = { categoria: '', marca: '', classificacao: '' }
const foto = new Uint8Array([255, 216, 255, 217])
const matriz = [
  { id: 'P1', categoriaId: 'C1', marca: 'X', classificacao: 'masculino', fisico: 3, promessa: 2 },
  { id: 'P2', categoriaId: 'C1', marca: 'X', classificacao: 'feminino', fisico: 2, promessa: 0 },
  { id: 'P3', categoriaId: 'C1', marca: 'X', classificacao: 'masculino', fisico: 3, promessa: 3 },
  { id: 'P4', categoriaId: 'C1', marca: 'X', classificacao: 'masculino', fisico: 1, promessa: 2 },
  { id: 'P5', categoriaId: 'C1', marca: undefined, classificacao: 'masculino', fisico: 5, promessa: 0 },
  { id: 'P6', categoriaId: 'C2', marca: 'X', classificacao: 'masculino', fisico: 4, promessa: 0 },
  { id: 'P7', categoriaId: 'C1', marca: ' x ', classificacao: 'masculino', fisico: 2, promessa: 0 },
  { id: 'P8', categoriaId: 'C1', marca: 'X', classificacao: undefined, fisico: 1, promessa: 0 },
  { id: 'P9', categoriaId: 'C1', marca: 'X', classificacao: 'unissex', fisico: 1, promessa: 0 },
] as const
function retrato(): RetratoDivulgacao {
  return { categorias: [{ id: 'C1', nome: 'Perfumes' }, { id: 'C2', nome: 'Sabonetes' }], clientes: [],
    produtos: matriz.map((p) => ({ id: p.id, nome: p.id, categoriaId: p.categoriaId, marca: p.marca, classificacao: p.classificacao, fotoId: p.id, precoVenda: 900719925474099312345n, custoManual: 7n })),
    miniaturas: matriz.map((p) => ({ fotoId: p.id, binario: foto })),
    movimentos: matriz.map((p) => ({ ...compra(`c-${p.id}`, p.fisico), produtoId: p.id })),
    lancamentos: matriz.filter((p) => p.promessa > 0).map((p) => venda(`v-${p.id}`, [{ ...item(`i-${p.id}`, p.promessa), produtoId: p.id }])) }
}
function previa(base = retrato()): PreviaDivulgacao { return { linhas: filtrarDivulgacao(base, filtros), desmarcados: [], novos: 0, alterada: false } }

test('RF-29 matriz independente E-28A: interseção, promessa e unissex, sem inferir ausências', () => {
  for (const [escolha, ids] of [
    [{ categoria: 'C1', marca: 'marca:x', classificacao: 'masculino' }, ['P1', 'P7', 'P9']],
    [{ categoria: 'C1', marca: 'marca:x', classificacao: 'feminino' }, ['P2', 'P9']],
    [{ categoria: 'C1', marca: 'marca:x', classificacao: '' }, ['P1', 'P2', 'P7', 'P8', 'P9']],
    [{ categoria: '', marca: 'marca:x', classificacao: 'masculino' }, ['P1', 'P6', 'P7', 'P9']],
    [{ categoria: 'C1', marca: '', classificacao: 'masculino' }, ['P1', 'P5', 'P7', 'P9']],
    [{ categoria: '', marca: 'sem-marca', classificacao: '' }, ['P5']],
    [{ categoria: '', marca: '', classificacao: 'sem-classificacao' }, ['P8']],
  ] satisfies readonly (readonly [FiltrosDivulgacao, readonly string[]])[]) {
    expect(filtrarDivulgacao(retrato(), escolha).map((linha) => linha.produto.id)).toEqual(ids)
  }
  expect(filtrarDivulgacao(retrato(), filtros).find((l) => l.produto.id === 'P1')).toMatchObject({ fisico: 3, prometido: 2, disponivel: 1 })
})

test('homônimos por identidade, marca com acento, não se aplica e ordenação por nome/id', () => {
  const base = retrato(), p = base.produtos[0]
  if (!p) throw new Error('matriz incompleta')
  const r: RetratoDivulgacao = { ...base, categorias: [...base.categorias, { id: 'C3', nome: 'Perfumes' }],
    produtos: [{ ...p, id: 'b', nome: 'Água', categoriaId: 'C3', marca: 'Óleo', classificacao: 'nao-se-aplica' },
      { ...p, id: 'a', nome: 'Água', marca: 'Oleo', classificacao: undefined }],
    movimentos: [{ ...compra('a'), produtoId: 'a' }, { ...compra('b'), produtoId: 'b' }], lancamentos: [] }
  expect(filtrarDivulgacao(r, filtros).map((l) => l.produto.id)).toEqual(['a', 'b'])
  expect(filtrarDivulgacao(r, { ...filtros, categoria: 'C1' }).map((l) => l.produto.id)).toEqual(['a'])
  expect(filtrarDivulgacao(r, { ...filtros, marca: chaveDaMarca(' óleo ') }).map((l) => l.produto.id)).toEqual(['b'])
  expect(filtrarDivulgacao(r, { ...filtros, classificacao: 'nao-se-aplica' }).map((l) => l.produto.id)).toEqual(['b'])
  expect(filtrarDivulgacao(r, { ...filtros, classificacao: 'sem-classificacao' }).map((l) => l.produto.id)).toEqual(['a'])
})

test('RN-06/D-054: contagem em disputa usa posição provisória; promessa/físico negativo não entram', () => {
  const base = retrato(), c = { ...compra('c', 10), produtoId: 'P1' }
  const contar = (id: string) => ok(novaContagem([c], { id, operacaoId: `op-${id}`, revisao: 1, produtoId: 'P1', data: '2026-10-02', totalContado: 7, motivo: 'conferencia' }))
  const a = contar('a'), b = contar('b')
  const linhas = filtrarDivulgacao({ ...base, movimentos: [c, a, b] }, filtros)
  expect(linhas.find((l) => l.produto.id === 'P1')).toMatchObject({ fisico: 10, prometido: 2, disponivel: 8, contagensAfetadas: true })
  expect(filtrarDivulgacao({ ...base, movimentos: [] }, filtros)).toEqual([])
  expect(() => filtrarDivulgacao({ ...base, movimentos: [{ ...c, quantidade: -1 }] }, filtros)).toThrow()
})

test('prévia relida não adiciona resultados, conserva desmarcados e retira indisponíveis explicitamente', () => {
  const inicial = previa(), p = inicial.linhas[0]
  if (!p) throw new Error('matriz incompleta')
  const atual = [...inicial.linhas.filter((l) => l.produto.id !== 'P1'), { ...p, produto: { ...p.produto, id: 'novo' } }]
  const relida = relerPreviaDivulgacao({ ...inicial, desmarcados: ['P2'] }, atual)
  expect(relida.alterada).toBe(true); expect(relida.novos).toBe(1); expect(relida.desmarcados).toEqual(['P2'])
  expect(relida.linhas.some((l) => l.produto.id === 'novo' || l.produto.id === 'P1')).toBe(false)
})

test('conteúdo explícito tem dinheiro exato/zero, não contém custo, ficha, telefone, id ou URL privada', () => {
  const p = previa().linhas[0]
  if (!p) throw new Error('matriz incompleta')
  const itens = itensPdfDivulgacao([p, { ...p, produto: { ...p.produto, precoVenda: 0n } }])
  expect(itens[0]).toEqual({ nome: 'P1', marca: 'X', preco: 900719925474099312345n, quantidade: 1, foto })
  expect(itens[1]?.preco).toBe(0n)
  expect(Object.keys(itens[0] ?? {}).sort()).toEqual(['foto', 'marca', 'nome', 'preco', 'quantidade'])
  expect(() => itensPdfDivulgacao([])).toThrow()
  expect(() => itensPdfDivulgacao([{ ...p, foto: undefined }])).toThrow()
  expect(() => itensPdfDivulgacao([{ ...p, produto: { ...p.produto, precoVenda: undefined } }])).toThrow()
  for (const outra of [{ ...p, foto: new Uint8Array([1, 2]) }, { ...p, disponivel: 99 }, { ...p, produto: { ...p.produto, nome: 'mudou' } }]) expect(mesmasLinhasDivulgacao([p], [outra])).toBe(false)
})

test('preparo relê antes/depois, retém fotos e rejeita arquivo se a quantidade mudar durante a geração', async () => {
  const base = retrato(), inicial = previa(base), usos: string[] = [], liberados: string[] = []
  let mudou = false, geracoes = 0
  const portas = { ler: async () => mudou ? { ...base, lancamentos: [] } : base,
    fotos: { reterReferencia: async (id: string) => { usos.push(id); return id }, liberarUso: async (id: string) => { liberados.push(id) } },
    gerar: async () => { geracoes++; mudou = true; return new File(['PDF'], 'teste.pdf') } }
  const resultado = await prepararDivulgacao({ ...inicial, desmarcados: ['P2'] }, filtros, portas)
  expect(resultado.estado).toBe('alterada'); expect(geracoes).toBe(1); expect(usos).not.toContain('P2'); expect(liberados).toEqual(usos)
  const antes = await prepararDivulgacao(inicial, filtros, portas)
  expect(antes.estado).toBe('alterada'); expect(geracoes).toBe(1)
})

test('preparo bem sucedido/falha não altera retrato e libera usos já retidos, inclusive retenção parcial', async () => {
  const base = retrato(), copia = structuredClone(base), inicial = previa(base), liberados: string[] = []
  const arquivo = new File(['PDF'], 'teste.pdf')
  const portas = { ler: async () => base, fotos: { reterReferencia: async (id: string) => id, liberarUso: async (id: string) => { liberados.push(id) } }, gerar: async () => arquivo }
  const resultado = await prepararDivulgacao(inicial, filtros, portas)
  expect(resultado.estado).toBe('pronta'); expect(base).toEqual(copia); expect(liberados.length).toBe(inicial.linhas.length)
  liberados.length = 0
  await expect(prepararDivulgacao(inicial, filtros, { ...portas, gerar: async () => { throw new Error('limite') } })).rejects.toThrow('limite')
  expect(liberados.length).toBe(inicial.linhas.length)
  liberados.length = 0
  await expect(prepararDivulgacao(inicial, filtros, { ...portas, fotos: { ...portas.fotos, reterReferencia: async (id) => { if (id === 'P2') throw new Error('mudou'); return id } } })).rejects.toThrow('mudou')
  expect(liberados).toEqual(['P1']); expect(base).toEqual(copia)
})

test('leitura consistente reúne miniaturas, compromissos e clientes sem originais nem gravações', async () => {
  const banco = new BancoLocal('divulgacao-e28c', { indexedDB: new IDBFactory(), IDBKeyRange })
  try {
    const base = retrato()
    await banco.categorias.bulkPut([...base.categorias]); await banco.produtos.bulkPut(base.produtos.map((p) => ({ ...p, atualizadoEm: '2026-10-25' })))
    await banco.movimentos.bulkPut([...base.movimentos]); await banco.lancamentos.bulkPut([...base.lancamentos])
    await banco.clientes.put({ id: 'cliente', nome: 'Cliente de teste', telefone: '85999999999', atualizadoEm: '2026-10-25' })
    const leitura = criarLeituraDivulgacao(banco)
    const semFotos = await leitura.ler()
    expect(semFotos.miniaturas).toEqual([]); expect(semFotos.lancamentos).toEqual(base.lancamentos)
    expect(semFotos.clientes[0]?.telefone).toBe('85999999999')
    expect(await banco.fila.count()).toBe(0); expect(await banco.usosFotos.count()).toBe(0)
  } finally { await banco.delete() }
})
