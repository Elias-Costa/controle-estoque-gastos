import { avaliarLembretes, calendarioLembretes, observacaoInicialLembretes, registrarRodadaLembretes } from '../dominio/lembretes.ts'
import type { BancoLocal } from './banco.ts'
import { uuidv7 } from './identidade.ts'
import { inscricaoPushValida, type InscricaoLocal, type InscricaoPush, type PedidoInscricaoLembretes } from './tipos-lembretes.ts'

/** Intenção e observação locais de D-079; a rede não entra em nenhuma transação. */
export function criarRepositorioLembretes(banco: BancoLocal, agora = () => new Date().toISOString()) {
  const fontes = [banco.clientes, banco.lancamentos, banco.produtos, banco.movimentos, banco.fatosCaixa]
  async function ler() {
    return banco.transaction('rw', [...fontes, banco.observacoesLembretes, banco.inscricoesLembretes], async () => {
      const instante = agora()
      const clientes = await banco.clientes.toArray()
      const avaliado = avaliarLembretes({ clientes, lancamentos: await banco.lancamentos.toArray(),
        produtos: await banco.produtos.toArray(), movimentos: await banco.movimentos.toArray(), fatosCaixa: await banco.fatosCaixa.toArray() },
      (await banco.observacoesLembretes.get('local'))?.valor ?? observacaoInicialLembretes(), instante)
      const valor = calendarioLembretes(instante).minutos >= 540
        ? registrarRodadaLembretes(avaliado.observacao, avaliado.motivos) : avaliado.observacao
      await banco.observacoesLembretes.put({ chave: 'local', valor })
      return { motivos: avaliado.motivos, nomes: Object.fromEntries(clientes.map((c) => [c.id, c.nome])),
        inscricao: await banco.inscricoesLembretes.get('atual') ?? null }
    })
  }
  async function solicitar(): Promise<InscricaoLocal> {
    return banco.transaction('rw', banco.inscricoesLembretes, banco.controleCopia, async () => {
      const vinculo = await banco.controleCopia.get('conta')
      if (vinculo?.chave !== 'conta') throw new Error('Conta ainda não confirmada')
      const atual = await banco.inscricoesLembretes.get('atual')
      if (atual && (atual.contaId !== vinculo.vinculo.contaId || atual.destino !== vinculo.vinculo.destino)) throw new Error('Outra conta')
      const nova: InscricaoLocal = { chave: 'atual', aparelhoId: atual?.aparelhoId ?? uuidv7(), ...vinculo.vinculo,
        revisao: Math.max(atual?.revisao ?? 0, atual?.confirmada ?? 0) + 1, confirmada: atual?.confirmada ?? 0, ativa: true, estado: 'solicitada' }
      if (!Number.isSafeInteger(nova.revisao)) throw new Error('Revisão inválida')
      await banco.inscricoesLembretes.put(nova)
      return nova
    })
  }
  async function completar(revisao: number, inscricao: InscricaoPush): Promise<void> {
    if (!inscricaoPushValida(inscricao)) throw new Error('Inscrição inválida')
    await banco.transaction('rw', banco.inscricoesLembretes, async () => {
      const atual = await banco.inscricoesLembretes.get('atual')
      if (atual?.revisao === revisao && atual.ativa) await banco.inscricoesLembretes.put({ ...atual, inscricao, estado: 'pendente' })
    })
  }
  async function desligar(): Promise<void> {
    await banco.transaction('rw', banco.inscricoesLembretes, async () => {
      const atual = await banco.inscricoesLembretes.get('atual')
      if (!atual) return
      const { inscricao: _credencial, ...semCredencial } = atual
      const revisao = Math.max(atual.revisao, atual.confirmada) + 1
      if (!Number.isSafeInteger(revisao)) throw new Error('Revisão inválida')
      await banco.inscricoesLembretes.put({ ...semCredencial, revisao, ativa: false, estado: 'pendente' })
    })
  }
  async function capturar(conferir = false): Promise<{ readonly local: InscricaoLocal; readonly pedido: PedidoInscricaoLembretes } | null> {
    const local = await banco.inscricoesLembretes.get('atual')
    if (!local || (local.estado !== 'pendente' && !(conferir && local.estado === 'ativa')) || local.ativa && !local.inscricao) return null
    return { local, pedido: { aparelhoId: local.aparelhoId, revisao: local.revisao, anterior: local.confirmada,
      ativa: local.ativa, ...(local.inscricao ? { inscricao: local.inscricao } : {}) } }
  }
  async function responder(envio: InscricaoLocal, revisao: number, estado: 'ativa' | 'desligada' | 'invalida' | 'problema' | 'pendente'): Promise<void> {
    if (!Number.isSafeInteger(revisao) || revisao < 0) throw new Error('Resposta de inscrição inválida')
    await banco.transaction('rw', banco.inscricoesLembretes, async () => {
      const atual = await banco.inscricoesLembretes.get('atual')
      if (!atual || atual.aparelhoId !== envio.aparelhoId || atual.contaId !== envio.contaId || atual.destino !== envio.destino) return
      // Resposta antiga só atualiza conhecimento; nunca conclui nem religa intenção posterior.
      await banco.inscricoesLembretes.put({ ...atual, confirmada: Math.max(atual.confirmada, revisao),
        estado: atual.revisao === envio.revisao ? estado : atual.estado })
    })
  }
  return { ler, solicitar, completar, desligar, capturar, responder,
    configuracao: async () => await banco.inscricoesLembretes.get('atual') ?? null }
}

/** Porta usada pelo controlador de inscrição e pela reserva local. */
export type RepositorioLembretes = ReturnType<typeof criarRepositorioLembretes>
