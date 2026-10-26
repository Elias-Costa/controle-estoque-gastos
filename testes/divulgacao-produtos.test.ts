import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarLeituraDivulgacao, type RetratoDivulgacao } from '../src/dados/leitura-divulgacao.ts'
import { chaveDaMarca, filtrarDivulgacao, itensPdfDivulgacao, secoesPdfDivulgacao, mesmasLinhasDivulgacao, relerPreviaDivulgacao, type FiltrosDivulgacao, type PreviaDivulgacao, type SecaoPdfDivulgacao } from '../src/interface/divulgacao-produtos.ts'
import { prepararDivulgacao } from '../src/interface/preparar-divulgacao.ts'
import { compra, item, venda, ok } from './apoio-estoque.ts'
import { novaContagem } from '../src/dominio/estoque.ts'

const filtros: FiltrosDivulgacao = { categorias: null, marcas: null, classificacao: '' }
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
    [{ categorias: ['C1'], marcas: ['marca:x'], classificacao: 'masculino' }, ['P1', 'P7', 'P9']],
    [{ categorias: ['C1'], marcas: ['marca:x'], classificacao: 'feminino' }, ['P2', 'P9']],
    [{ categorias: ['C1'], marcas: ['marca:x'], classificacao: '' }, ['P1', 'P2', 'P7', 'P8', 'P9']],
    [{ categorias: null, marcas: ['marca:x'], classificacao: 'masculino' }, ['P1', 'P6', 'P7', 'P9']],
    [{ categorias: ['C1'], marcas: null, classificacao: 'masculino' }, ['P1', 'P5', 'P7', 'P9']],
    [{ categorias: null, marcas: ['sem-marca'], classificacao: '' }, ['P5']],
    [{ categorias: null, marcas: null, classificacao: 'sem-classificacao' }, ['P8']],
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
  expect(filtrarDivulgacao(r, { ...filtros, categorias: ['C1'] }).map((l) => l.produto.id)).toEqual(['a'])
  expect(filtrarDivulgacao(r, { ...filtros, marcas: [chaveDaMarca(' óleo ')] }).map((l) => l.produto.id)).toEqual(['b'])
  expect(filtrarDivulgacao(r, { ...filtros, classificacao: 'nao-se-aplica' }).map((l) => l.produto.id)).toEqual(['b'])
  expect(filtrarDivulgacao(r, { ...filtros, classificacao: 'sem-classificacao' }).map((l) => l.produto.id)).toEqual(['a'])
  const secoes = secoesPdfDivulgacao(filtrarDivulgacao(r, filtros))
  expect(secoes.map((s) => s.categoria)).toEqual(['Perfumes (1)', 'Perfumes (2)'])
  expect(secoes.map((s) => s.itens.map((i) => i.marca))).toEqual([['Oleo'], ['Óleo']])
})

test('D-074 seções alfabéticas por categoria e produtos, sem seção vazia ou ids na porta do PDF', () => {
  const base = retrato(), linhas = filtrarDivulgacao({ ...base,
    categorias: [{ id: 'C1', nome: 'Perfumes' }, { id: 'C2', nome: 'Acessórios' }, { id: 'C3', nome: 'Vazia' }] }, filtros)
  const invertidas = [...linhas].reverse(), copia = structuredClone(invertidas)
  const secoes = secoesPdfDivulgacao(invertidas)
  expect(secoes.map((s) => s.categoria)).toEqual(['Acessórios', 'Perfumes'])
  expect(secoes.map((s) => s.itens.map((i) => i.nome))).toEqual([['P6'], ['P1', 'P2', 'P5', 'P7', 'P8', 'P9']])
  expect(secoes.map((s) => Object.keys(s).sort())).toEqual([['categoria', 'itens'], ['categoria', 'itens']])
  expect(invertidas).toEqual(copia)
  expect(secoesPdfDivulgacao(linhas.filter((l) => l.produto.categoriaId === 'C2')).map((s) => s.categoria)).toEqual(['Acessórios'])
  expect(() => secoesPdfDivulgacao([])).toThrow()
  expect(() => filtrarDivulgacao({ ...base, categorias: [] }, filtros)).toThrow('Categoria incompleta')
})

test('D-074 nome/rótulo da categoria alterado durante o preparo invalida o PDF e libera fotos', async () => {
  const base = retrato(), inicial = previa(base)
  for (const categorias of [base.categorias.map((c) => ({ ...c, nome: `Nova ${c.nome}` })), [...base.categorias, { id: 'C3', nome: 'Perfumes' }]]) {
    let mudou = false
    const liberados: string[] = [], recebidas: SecaoPdfDivulgacao[] = []
    const resultado = await prepararDivulgacao(inicial, filtros, {
      ler: async () => mudou ? { ...base, categorias } : base,
      fotos: { reterReferencia: async (id) => id, liberarUso: async (id) => { liberados.push(id) } },
      gerar: async (secoes) => { recebidas.push(...secoes); mudou = true; return new File(['PDF'], 'teste.pdf') },
    })
    expect(recebidas.map((s) => s.categoria)).toEqual(['Perfumes', 'Sabonetes'])
    expect(resultado.estado).toBe('alterada')
    expect(resultado.previa.alterada).toBe(true)
    expect(resultado.previa.desmarcados).toEqual(inicial.desmarcados)
    expect(liberados).toHaveLength(inicial.linhas.length)
  }
})

test('D-074 várias categorias e marcas: união por grupo, interseção, nenhuma e seleção fora do catálogo', () => {
  const base = retrato(), modelo = base.produtos[0]
  if (!modelo) throw new Error('matriz incompleta')
  const adicionais = [
    { id: 'P10', categoriaId: 'C2', marca: 'Y', classificacao: 'unissex' },
    { id: 'P11', categoriaId: 'C3', marca: 'X', classificacao: 'masculino' },
    { id: 'P12', categoriaId: 'C3', marca: 'Z', classificacao: 'unissex' },
    { id: 'P13', categoriaId: 'C1', marca: 'Z', classificacao: 'masculino' },
    { id: 'P14', categoriaId: 'C2', marca: undefined, classificacao: 'masculino' },
  ] as const
  const r: RetratoDivulgacao = { ...base, categorias: [...base.categorias, { id: 'C3', nome: 'Outra categoria' }],
    produtos: [...base.produtos, ...adicionais.map((p) => ({ ...modelo, ...p, nome: p.id }))],
    movimentos: [...base.movimentos, ...adicionais.map((p) => ({ ...compra(`c-${p.id}`, 1), produtoId: p.id }))] }
  const escolha: FiltrosDivulgacao = { categorias: ['C1', 'C2'], marcas: ['marca:x', 'marca:y'], classificacao: 'masculino' }
  const ids = (f: FiltrosDivulgacao) => filtrarDivulgacao(r, f).map((l) => l.produto.id)
  expect(ids(escolha)).toEqual(['P1', 'P10', 'P6', 'P7', 'P9'])
  expect(ids({ ...escolha, categorias: ['C2', 'C1', 'C1'], marcas: ['marca:y', 'marca:x', 'marca:x'] })).toEqual(ids(escolha))
  expect(ids({ ...escolha, categorias: [] })).toEqual([])
  expect(ids({ ...escolha, marcas: [] })).toEqual([])
  expect(ids({ ...escolha, categorias: ['inexistente'] })).toEqual([])
  expect(ids({ ...escolha, marcas: ['marca:inexistente'] })).toEqual([])
  expect(ids({ ...escolha, marcas: ['sem-marca', 'marca:y'] })).toEqual(['P10', 'P14', 'P5'])
  expect(ids({ ...escolha, categorias: null })).toContain('P11')
  expect(ids({ ...escolha, marcas: null })).toContain('P13')
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
