import { afterEach, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, type TabelaDaFila } from '../src/dados/banco.ts'
import { criarLeituraProblemasDeEnvio, type ProblemaDeEnvio } from '../src/dados/problemas-de-envio.ts'
import { linkDoRelatoDeEnvio, relatoDeEnvio } from '../src/interface/relato-de-envio.ts'

const bancos: BancoLocal[] = []
const instante = '2026-10-26T12:00:00.000Z'
const erro = { codigo: '23505', constraint: 'lancamentos_um_estorno_por_alvo', mensagem: 'Recusa: "anotação" já existente & outra?', em: instante }
afterEach(() => { for (const banco of bancos.splice(0)) banco.close() })
function abrir() {
  const banco = new BancoLocal('relato-teste', { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(banco); return banco
}
async function retrato(banco: BancoLocal) {
  return Promise.all(banco.tables.map(async (tabela) => [tabela.name, await tabela.toArray()]))
}

test('D-077 lê recusas de todas as rotas em ordem e não modifica nenhuma tabela ou versão', async () => {
  const banco = abrir()
  const tabelas: TabelaDaFila[] = ['clientes', 'lancamentos', 'categorias', 'produtos', 'operacoes', 'encerramentos', 'fotos', 'identidadeLoja']
  for (const [indice, tabela] of tabelas.entries()) {
    await banco.fila.add({ tabela, registroId: `recusado-${indice}`, criadoEm: instante, problema: erro,
      ...(indice ? { versao: indice } : {}) })
  }
  await banco.fila.add({ tabela: 'clientes', registroId: 'pendente', criadoEm: instante })
  await banco.clientes.add({ id: 'cliente', nome: 'NOME PRIVADO', telefone: 'TELEFONE PRIVADO', atualizadoEm: instante })
  await banco.lancamentos.add({ id: 'venda', clienteId: 'cliente', tipo: 'venda', data: '2026-10-26', pagamento: 'avista',
    forma: 'pix', desconto: 0n, itens: [{ descricao: 'ITEM PRIVADO', preco: 9007199254740993n }] })
  const antes = await retrato(banco)
  const problemas = await criarLeituraProblemasDeEnvio(banco).ler()
  expect(problemas.map((p) => p.tabela)).toEqual(tabelas)
  expect(problemas.map((p) => p.versao)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(problemas[0]).toEqual({ tabela: 'clientes', registroId: 'recusado-0', criadoEm: instante, versao: 0, problema: erro })
  expect(await retrato(banco)).toEqual(antes)
  const texto = relatoDeEnvio(problemas, '26/10, 16:00')
  for (const privado of ['NOME PRIVADO', 'TELEFONE PRIVADO', 'ITEM PRIVADO', '9007199254740993', 'pendente']) expect(texto).not.toContain(privado)
})

test('relato fechado conserva diagnóstico exato e destino, sem propriedades extras ou sessão', () => {
  const problema: ProblemaDeEnvio = { tabela: 'lancamentos', registroId: 'identidade-do-erro', versao: 3, criadoEm: instante,
    problema: { ...erro } }
  Object.assign(problema, { sessao: 'TOKEN PRIVADO', binario: 'FOTO PRIVADA', cliente: 'CLIENTE PRIVADO' })
  Object.assign(problema.problema, { detalhesExtras: 'OUTRO SEGREDO' })
  const url = new URL(linkDoRelatoDeEnvio([problema], '26/10, 16:00', '5511999999999'))
  expect(url.origin + url.pathname).toBe('https://wa.me/5511999999999')
  const texto = url.searchParams.get('text')!
  expect(texto).toContain('26/10, 16:00')
  expect(texto).toContain('identidade-do-erro')
  const documento: { problemas: ProblemaDeEnvio[] } = JSON.parse(texto.slice(texto.indexOf('{')))
  expect(documento.problemas[0]?.problema).toEqual(erro)
  for (const privado of ['TOKEN PRIVADO', 'FOTO PRIVADA', 'CLIENTE PRIVADO', 'OUTRO SEGREDO']) expect(texto).not.toContain(privado)
  expect(relatoDeEnvio([{ ...problema, problema: { codigo: '23000', mensagem: 'sem constraint', em: instante } }], 'teste')).not.toContain('"constraint":')
  expect(() => linkDoRelatoDeEnvio([problema], 'teste', '')).toThrow('Contato de suporte inválido')
})

test('observação atualiza uma recusa sem mudar a quantidade e retira o relato quando resolvida', async () => {
  // liveQuery exige a disponibilidade global de IndexedDB, além da injeção na base.
  const anterior = Dexie.dependencies.indexedDB
  Dexie.dependencies.indexedDB = new IDBFactory()
  const banco = abrir(), leitura = criarLeituraProblemasDeEnvio(banco)
  const ordem = await banco.fila.add({ tabela: 'produtos', registroId: 'produto', versao: 1, criadoEm: instante, problema: erro })
  const vistos: (readonly ProblemaDeEnvio[])[] = []
  const cancelar = leitura.assinar((problemas) => vistos.push(problemas), () => { throw new Error('Falha de observação') })
  try {
    await esperar(() => vistos.at(-1)?.[0]?.versao === 1)
    await banco.fila.update(ordem, { versao: 2, problema: { ...erro, mensagem: 'Outro diagnóstico' } })
    await esperar(() => vistos.at(-1)?.[0]?.problema.mensagem === 'Outro diagnóstico')
    expect(vistos.at(-1)?.[0]?.versao).toBe(2)
    await banco.fila.update(ordem, { problema: undefined })
    await esperar(() => vistos.at(-1)?.length === 0)
    expect(await banco.fila.count()).toBe(1)
  } finally { cancelar(); Dexie.dependencies.indexedDB = anterior }
})

test('falha de leitura é propagada, sem fabricar diagnóstico nem abrir outra base', async () => {
  const banco = abrir()
  await banco.open(); banco.close({ disableAutoOpen: true })
  await expect(criarLeituraProblemasDeEnvio(banco).ler()).rejects.toThrow()
})

test('observação informa base fechada, sem manter a tela preparando indefinidamente', async () => {
  const anterior = Dexie.dependencies.indexedDB
  Dexie.dependencies.indexedDB = new IDBFactory()
  const banco = abrir(); await banco.open(); banco.close({ disableAutoOpen: true })
  let falhou = false
  const cancelar = criarLeituraProblemasDeEnvio(banco).assinar(() => { throw new Error('Diagnóstico fabricado') }, () => { falhou = true })
  try { await esperar(() => falhou); expect(banco.isOpen()).toBe(false) }
  finally { cancelar(); Dexie.dependencies.indexedDB = anterior }
})

async function esperar(condicao: () => boolean) {
  const limite = Date.now() + 2000
  while (!condicao()) {
    if (Date.now() > limite) throw new Error('A leitura observada não atualizou')
    await new Promise((resolver) => setTimeout(resolver, 10))
  }
}
