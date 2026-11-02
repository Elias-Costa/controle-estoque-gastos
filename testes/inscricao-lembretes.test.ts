import { afterEach, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { criarRepositorioLembretes } from '../src/dados/repositorio-lembretes.ts'
import { vincularContaCopia } from '../src/dados/repositorio-copia.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { cadastrarCliente, lancarVendaFiado } from '../src/dados/operacoes.ts'
import { criarServicoLembretes, type NuvemLembretes } from '../src/sincronizacao/lembretes.ts'
import { avisoDaMensagemPush } from '../src/plataforma/aviso-push.ts'
import type { PortaPush } from '../src/plataforma/push.ts'
const bancos: BancoLocal[] = []
afterEach(() => bancos.splice(0).forEach((b) => b.close()))
const inscricao = { endpoint: 'https://fcm.googleapis.com/ficticio', p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) }
async function preparar(mudancasPush: Partial<PortaPush> = {}, mudancasNuvem: Partial<NuvemLembretes> = {}) {
  const b = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(b)
  const vinculo = { contaId: uuidv7(), destino: 'http://127.0.0.1:54321' }; await vincularContaCopia(b, vinculo)
  let permissoes = 0, envios = 0
  const push: PortaPush = { disponivel: () => true, permitida: () => true, atual: async () => inscricao,
    pedirPermissao: async () => { permissoes++; return true }, inscrever: async () => inscricao, desligar: async () => undefined, ...mudancasPush }
  const nuvem: NuvemLembretes = { identidade: async () => vinculo, chavePublica: async () => 'B'.repeat(87),
    registrar: async (pedido) => { envios++; return { revisao: pedido.revisao, estado: pedido.ativa ? 'ativa' : 'desligada' } }, ...mudancasNuvem }
  const repo = criarRepositorioLembretes(b), servico = criarServicoLembretes(repo, push, nuvem)
  return { b, repo, servico, permissoes: () => permissoes, envios: () => envios }
}
test('primeira abertura não pede permissão; ativa somente após navegador e servidor confirmarem', async () => {
  const p = await preparar()
  await p.servico.acordar(true)
  expect(p.permissoes()).toBe(0); expect(p.envios()).toBe(0)
  await p.servico.ativar()
  expect(p.permissoes()).toBe(1)
  expect((await p.repo.configuracao())?.estado).toBe('ativa')
  expect(await p.b.fila.count()).toBe(0)
})
test('negativa mantém reserva local e desligamento, sem inscrição enviada como ativa', async () => {
  const p = await preparar({ pedirPermissao: async () => false, permitida: () => false })
  await p.servico.ativar(); await p.servico.acordar()
  expect((await p.repo.configuracao())?.ativa).toBe(false)
  expect(p.servico.erro()).toBe('negada')
  expect((await p.repo.ler()).motivos).toBeDefined()
})
test('inscrição sem rede não bloqueia venda real nem seu item da FIFO', async () => {
  const inicio = Promise.withResolvers<void>(), retorno = Promise.withResolvers<string>()
  const p = await preparar({}, { chavePublica: () => { inicio.resolve(); return retorno.promise } })
  const ativacao = p.servico.ativar(); await inicio.promise
  const repo = criarRepositorioLocal(p.b), cliente = await cadastrarCliente(repo, { nome: 'Fictícia offline' })
  if (!cliente.ok) throw new Error(cliente.motivo)
  const venda = await lancarVendaFiado(repo, { clienteId: cliente.valor.id, data: '2026-10-31',
    itens: [{ descricao: 'Fictício', preco: 9007199254740993n }], parcelas: [{ vencimento: '2026-11-01', valor: 9007199254740993n }] })
  expect(venda.ok).toBe(true)
  expect(await p.b.lancamentos.count()).toBe(1)
  expect(await p.b.fila.count()).toBe(2)
  retorno.resolve('B'.repeat(87)); await ativacao
  expect(await p.b.fila.count()).toBe(2)
})
test('resposta perdida conserva pedido; retentativa idêntica conclui sem criar identidade nova', async () => {
  let primeira = true
  const p = await preparar({}, { registrar: async (pedido) => {
    if (primeira) { primeira = false; throw new Error('Resposta perdida') }
    return { revisao: pedido.revisao, estado: 'ativa' }
  } })
  await p.servico.ativar()
  const antes = await p.repo.capturar(); expect(antes).not.toBeNull()
  await p.servico.acordar()
  expect((await p.repo.configuracao())?.aparelhoId).toBe(antes?.local.aparelhoId)
  expect((await p.repo.configuracao())?.estado).toBe('ativa')
  expect(await p.repo.capturar()).toBeNull()
})
test('outra conta/destino não recebe inscrição; permissão revogada não permanece ativa', async () => {
  const errada = await preparar({}, { identidade: async () => ({ contaId: uuidv7(), destino: 'http://127.0.0.1:54321' }) })
  await errada.servico.ativar(); expect(errada.envios()).toBe(0)
  let real = true
  const p = await preparar({ atual: async () => real ? inscricao : null })
  await p.servico.ativar(); real = false
  await p.servico.acordar(true)
  expect((await p.repo.configuracao())?.estado).toBe('desligada')
})
test('tela bloqueada ignora texto, URL e dados privados injetados no payload', () => {
  const aviso = avisoDaMensagemPush({ formato: 1, rodada: 'a'.repeat(32), body: 'Nome e valor privados', url: 'https://evil.invalid' })
  expect(aviso).toEqual({ titulo: 'Fichinhas', opcoes: { body: 'Há lembretes para conferir.', tag: `lembretes-${'a'.repeat(32)}`,
    icon: '/icones/icone-192.png', data: { lembretes: true } } })
  expect(avisoDaMensagemPush(null).opcoes.body).toBe('Há lembretes para conferir.')
})
