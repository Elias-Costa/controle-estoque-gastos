import { afterEach, describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, ESQUEMA_V6 } from '../src/dados/banco.ts'
import { MODELOS_ORIGINAIS, SITUACOES_MENSAGEM, modeloValido, modelosValidos, type PreferenciaModelos } from '../src/dados/modelos-whatsapp.ts'
import { criarRepositorioModelos } from '../src/dados/repositorio-modelos.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { renderizarModelo } from '../src/interface/modelos-da-mensagem.ts'
import { mensagemDeCobranca, mensagemDeRecibo } from '../src/interface/palavras-da-cobranca.ts'
import { aplicarModelos } from '../src/sincronizacao/recepcao-modelos.ts'
import { modelosDaNuvem, modelosParaNuvem } from '../src/sincronizacao/borda-modelos.ts'
import { criarServicoCopia } from '../src/sincronizacao/copia.ts'
import { vincularContaCopia } from '../src/dados/repositorio-copia.ts'
import { lerArquivoCopia } from '../src/plataforma/arquivo-copia.ts'
import { pacoteSemModelos } from './apoio-modelos.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { cadastrarCliente, lancarVendaFiado } from '../src/dados/operacoes.ts'
import { saldo } from '../src/dominio/ficha.ts'

const AGORA = '2026-10-25T12:00:00.000Z', DEPOIS = '2026-10-25T12:01:00.000Z'
const bancos: BancoLocal[] = []
function banco(fabrica = new IDBFactory(), nome = uuidv7()) { const b = new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange }); bancos.push(b); return b }
function preferencia(atualizadoEm = AGORA): PreferenciaModelos { return { chave: 'whatsapp', id: uuidv7(), atualizadoEm, modelos: MODELOS_ORIGINAIS } }
afterEach(() => { for (const b of bancos.splice(0)) b.close() })

describe('E-36 modelos: texto puro, persistência e arquivo; sem prova de aparelho', () => {
  test('os quatro padrões conservam exatamente as frases de F1', () => {
    expect(mensagemDeCobranca({ nome: 'Maria Silva', vencimento: '2026-10-30', vencida: true })).toBe('Oi, Maria, tudo bem? Passando para lembrar da parcela que está atrasada. Quando puder, me mande, por favor. Obrigada!')
    expect(mensagemDeCobranca({ nome: 'Dona Rosa Silva', vencimento: '2026-10-30', vencida: false })).toBe('Oi, Dona Rosa, tudo bem? Passando para lembrar da parcela que vence em 30/10. Quando puder, me mande, por favor. Obrigada!')
    expect(mensagemDeRecibo({ nome: 'Seu João Silva', valor: 5000n, saldo: 12500n })).toBe('Oi, Seu João! Recebi os R$ 50,00, obrigada! Agora falta R$ 125,00 na sua fichinha.')
    expect(mensagemDeRecibo({ nome: 'Rosa', valor: 5000n, saldo: 0n })).toBe('Oi, Rosa! Recebi os R$ 50,00, obrigada! Sua fichinha está quitada!')
  })
  test('centavos grandes, saldo zero e calendário válido sem arredondar ou interpretar dado inserido', () => {
    expect(renderizarModelo('{nome}: {valor} / {saldo}', 'recibo-com-saldo', { nome: 'Ana{valor}', valor: 9007199254740993n, saldo: 0n }))
      .toEqual({ ok: true, texto: 'Ana{valor}: R$ 90.071.992.547.409,93 / R$ 0,00' })
    expect(renderizarModelo('{vencimento} {valor}', 'cobranca-vencida', { vencimento: '2028-02-29', valor: 1n })).toEqual({ ok: true, texto: '29/02 R$ 0,01' })
    for (const vencimento of ['2026-02-29', '2026-13-01', '30/10', '']) expect(renderizarModelo('{vencimento}', 'cobranca-a-vencer', { vencimento }).ok).toBe(false)
  })
  test('vazio, marcador incompleto, desconhecido e variável fora do contexto são recusados; texto livre é válido', () => {
    for (const s of SITUACOES_MENSAGEM) {
      for (const t of ['', ' \n\t ', '{', 'nome}', '{}', '{{nome}}', '{telefone}', '{ nome }']) expect(modeloValido(t, s)).toBe(false)
      expect(modeloValido('Mensagem sem trechos.', s)).toBe(true)
      expect(modeloValido(MODELOS_ORIGINAIS[s], s)).toBe(true)
    }
    expect(modeloValido('{saldo}', 'cobranca-vencida')).toBe(false)
    expect(modeloValido('{vencimento}', 'recibo-quitado')).toBe(false)
    expect(modelosValidos({ ...MODELOS_ORIGINAIS, extra: 'x' })).toBe(false)
    expect(modelosValidos({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 1 })).toBe(false)
    expect(renderizarModelo('{valor}', 'recibo-quitado', {}).ok).toBe(false)
    expect(renderizarModelo('{nome}', 'recibo-com-saldo', { nome: ' ' }).ok).toBe(false)
    expect(renderizarModelo('{saldo}', 'recibo-com-saldo', { saldo: -1n })).toEqual({ ok: true, texto: '-R$ 0,01' })
  })
  test('a borda exige todos os textos, identidade e instante, e não executa texto', () => {
    const p = preferencia(), doc = modelosParaNuvem(p)
    expect(modelosDaNuvem({ ...doc, recebido_em: AGORA })).toEqual(p)
    for (const defeito of [{ modelos: {} }, { id: 'servidor' }, { atualizado_em: '' }, { chave: 'outra' }]) expect(() => modelosDaNuvem({ ...doc, ...defeito })).toThrow()
    expect(renderizarModelo('<script>alert(1)</script> ${alert(1)}', 'recibo-quitado', {}).ok).toBe(false)
    expect(renderizarModelo('<b>texto</b>', 'recibo-quitado', {})).toEqual({ ok: true, texto: '<b>texto</b>' })
  })
  test('duas abas não substituem silenciosamente o rascunho e confirmam o conjunto observado', async () => {
    const fabrica = new IDBFactory(), nome = uuidv7(), a = banco(fabrica, nome), b = banco(fabrica, nome)
    const ra = criarRepositorioModelos(a, () => AGORA), rb = criarRepositorioModelos(b, () => DEPOIS)
    const resultados = await Promise.all([ra.salvar(MODELOS_ORIGINAIS, undefined), rb.salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Outro recibo' }, undefined)])
    expect(resultados.filter((r) => r.ok)).toHaveLength(1)
    expect(await a.fila.count()).toBe(1)
    const antiga = await ra.ler()
    const salvo = await rb.salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Confirmado' }, antiga)
    expect(salvo.ok).toBe(true)
    expect((await ra.salvar(MODELOS_ORIGINAIS, antiga)).ok).toBe(false)
    expect((await a.modelos.toArray())).toHaveLength(1)
  })
  test('falha da fila desfaz a preferência; base vazia não materializa os padrões', async () => {
    const b = banco(), r = criarRepositorioModelos(b)
    expect(await r.ler()).toBeUndefined(); expect(await b.fila.count()).toBe(0)
    const adicionar = b.fila.add.bind(b.fila)
    b.fila.add = () => Dexie.Promise.reject(new Error('fila indisponível'))
    await expect(r.salvar(MODELOS_ORIGINAIS, undefined)).rejects.toThrow('fila indisponível')
    b.fila.add = adicionar
    expect(await b.modelos.count()).toBe(0); expect(await b.fila.count()).toBe(0)
    await expect(r.salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': '' }, undefined)).rejects.toThrow()
  })
  test('sucesso ou recusa antiga não conclui a edição feita durante o envio; reabre com a fila', async () => {
    for (const recusar of [false, true]) {
      const b = banco(), r = criarRepositorioModelos(b, () => AGORA)
      const primeira = await r.salvar(MODELOS_ORIGINAIS, undefined); if (!primeira.ok) throw new Error('sem preferência')
      const envio = await r.capturarEnvio(primeira.preferencia.id); if (!envio) throw new Error('sem envio')
      await r.salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Editado durante envio' }, primeira.preferencia)
      await r.responderEnvio(envio, recusar ? { codigo: '23514', mensagem: 'Recusa antiga', em: AGORA } : undefined)
      b.close(); await b.open()
      expect((await r.ler())?.modelos['recibo-quitado']).toBe('Editado durante envio')
      expect((await b.fila.toArray())[0]?.versao).toBe(1)
      expect((await b.fila.toArray())[0]?.problema).toBeUndefined()
    }
  })
  test('recepção LWW conserva a edição pendente e resolve id inicial concorrente e empate remoto', async () => {
    const b = banco(), r = criarRepositorioModelos(b, () => AGORA)
    const salvo = await r.salvar(MODELOS_ORIGINAIS, undefined); if (!salvo.ok) throw new Error('sem preferência')
    await aplicarModelos(b, { ...preferencia(AGORA), modelos: { ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Empate remoto' } })
    expect((await r.ler())?.id).toBe(salvo.preferencia.id)
    const remoto = { ...preferencia(DEPOIS), modelos: { ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Remoto novo' } }
    await aplicarModelos(b, remoto); expect(await r.ler()).toEqual(remoto); expect(await b.fila.count()).toBe(0)
    await aplicarModelos(b, { ...remoto, modelos: MODELOS_ORIGINAIS }); expect((await r.ler())?.modelos).toEqual(MODELOS_ORIGINAIS)
    await aplicarModelos(b, salvo.preferencia); expect((await r.ler())?.id).toBe(remoto.id)
  })
  test('upgrade v6 conserva estágio, evidência, cadastro e fila sem criar preferência', async () => {
    const fabrica = new IDBFactory(), nome = uuidv7(), antiga = new Dexie(nome, { indexedDB: fabrica, IDBKeyRange })
    antiga.version(6).stores(ESQUEMA_V6); await antiga.open()
    await antiga.table('clientes').put({ id: 'legado', nome: 'Original' })
    await antiga.table('fila').add({ tabela: 'clientes', registroId: 'legado', criadoEm: AGORA })
    await antiga.table('lotesCopia').add({ id: 'lote', operacaoId: 'estagio', tabela: 'clientes', linhas: [{ id: 'legado', nome: 'Original' }] })
    antiga.close()
    const atual = banco(fabrica, nome); await atual.open()
    expect(await atual.clientes.get('legado')).toMatchObject({ id: 'legado', nome: 'Original' })
    expect(await atual.fila.count()).toBe(1); expect(await atual.lotesCopia.count()).toBe(1); expect(await atual.modelos.count()).toBe(0)
  })
  test('arquivo novo restaura preferência/fila; formato anterior usa padrões sem fabricar edição', async () => {
    const origem = banco(), vinculo = { contaId: uuidv7(), destino: 'local-ficticio' }
    await vincularContaCopia(origem, vinculo)
    const repo = criarRepositorioLocal(origem)
    const cliente = await cadastrarCliente(repo, { nome: 'Ficha do pacote anterior' }); if (!cliente.ok) throw new Error(cliente.motivo)
    const venda = await lancarVendaFiado(repo, { clienteId: cliente.valor.id, data: '2026-10-25', itens: [{ descricao: 'Item anterior', preco: 9007199254740993n }],
      parcelas: [{ vencimento: '2026-11-25', valor: 9007199254740993n }] }); if (!venda.ok) throw new Error(venda.motivo)
    const antigoBase = await criarServicoCopia(origem, null).exportar()
    const antigo = await pacoteSemModelos(antigoBase.arquivo, true)
    const anterior = (await lerArquivoCopia(antigo, vinculo)).dados
    expect(anterior.modelos).toEqual([]); expect(saldo(anterior.lancamentos)).toBe(9007199254740993n)
    expect(anterior.fila.some((f) => f.tabela === 'modelos')).toBe(false)
    const incompleto = await pacoteSemModelos(antigoBase.arquivo, false)
    await expect(lerArquivoCopia(incompleto, vinculo)).rejects.toThrow()
    await criarRepositorioModelos(origem, () => AGORA).salvar(MODELOS_ORIGINAIS, undefined)
    const arquivo = await criarServicoCopia(origem, null).exportar()
    const destino = banco(); await vincularContaCopia(destino, vinculo)
    const servico = criarServicoCopia(destino, null)
    await servico.importar(arquivo.arquivo, await servico.reservarImportacao())
    destino.close(); await destino.open()
    expect(await destino.modelos.toArray()).toEqual(await origem.modelos.toArray())
    expect((await destino.fila.toArray()).filter((f) => f.tabela === 'modelos')).toHaveLength(1)
  })
})
