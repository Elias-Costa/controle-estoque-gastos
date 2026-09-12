/**
 * O repositório: a porta pela qual o resto do app lê e grava a base local (E-05).
 *
 * Existe como **interface** (`Repositorio`) e uma implementação (`criarRepositorioLocal`)
 * para que as operações e as telas nunca importem Dexie: quem lê a ficha não sabe que
 * existe IndexedDB, e um teste de tela pode usar um repositório de mentira. A regra de
 * negócio **não** mora aqui — mora no domínio, que já validou o que chega. O repositório é
 * burro de propósito: grava o que recebeu e enfileira.
 *
 * Duas coisas que não são detalhe:
 *
 * - **Toda gravação entra na fila na mesma transação** (RI-02, EL-01). Uma linha gravada
 *   sem item na fila nunca subiria para a nuvem — existiria só neste aparelho, que é EL-05
 *   pela porta dos fundos. Uma transação `rw` sobre as duas tabelas faz as duas escritas
 *   acontecerem juntas ou nenhuma.
 * - **Não há `apagar`.** Lançamento financeiro não se apaga (RI-03): correção é estorno ou
 *   substituição pelo mesmo id (D-013), e as duas passam por `gravarLancamento`. Cliente
 *   também não se apaga em F1 — não há requisito, então não há método.
 */

import type { Cliente, Ficha, Id, Lancamento } from '../dominio/ficha.ts'
import type { BancoLocal, TabelaSincronizada } from './banco.ts'

/** O que o app precisa da base. Só isto; o que a sincronização precisa ela pega no banco (E-07). */
export type Repositorio = {
  /** Todas as clientes — cabem em memória (RNF-05); ordenar e buscar é da tela (E-09). */
  readonly listarClientes: () => Promise<Cliente[]>
  readonly lerCliente: (id: Id) => Promise<Cliente | undefined>
  /** Os lançamentos da cliente, na ordem do índice (id = ordem de criação, D-029). */
  readonly lerFicha: (clienteId: Id) => Promise<Ficha>
  /** Cria ou substitui pelo id (cadastro é last-write-wins, D-010) e enfileira. */
  readonly gravarCliente: (cliente: Cliente) => Promise<void>
  /** Cria ou substitui pelo id (correção no lugar, D-013) e enfileira. */
  readonly gravarLancamento: (lancamento: Lancamento) => Promise<void>
  /**
   * "Já subiu?" (D-013): `true` quando não há item na fila para o registro — nem pendente, nem
   * com problema. É o que a tela passa como `Correcao` ao domínio para decidir entre corrigir
   * no lugar e estornar (`caminhoDeCorrecao`). A fila é a fonte; não há campo copiado (D-040).
   */
  readonly sincronizado: (id: Id) => Promise<boolean>
  /**
   * "A nuvem recusou?" (D-042, item 2): `true` quando o item do registro está na fila marcado
   * "com problema". Para esse registro a tela oferece só "desfazer" (E-10, D-045): regravá-lo
   * tentaria de novo o que a nuvem já recusou.
   */
  readonly comProblema: (id: Id) => Promise<boolean>
}

/**
 * O repositório sobre a base local. `agora` é o relógio para o `criadoEm` da fila e para o
 * `atualizadoEm` do cliente (D-042); é parâmetro só para os testes fixarem o instante.
 * `aoEnfileirar` é chamado depois de cada gravação confirmada — é como a sincronização fica
 * sabendo que há algo novo para subir, sem que esta pasta a conheça (a dependência é
 * `sincronizacao → dados`, nunca o inverso).
 */
export function criarRepositorioLocal(
  banco: BancoLocal,
  agora: () => string = () => new Date().toISOString(),
  aoEnfileirar: () => void = () => undefined,
): Repositorio {
  /**
   * No máximo um item pendente por registro (D-040): se a linha já está na fila, regravá-la
   * antes de subir não cria um segundo item — o que sobe é a linha como estiver na hora do
   * envio. O que muda ao regravar (D-042): a `versao` sobe, para que um envio em andamento
   * não remova o item achando que subiu a versão certa; e um `problema` some — se ela mexeu,
   * tenta de novo. Chamada sempre de dentro da transação de gravação.
   */
  async function enfileirar(tabela: TabelaSincronizada, registroId: Id, instante: string): Promise<void> {
    const pendente = await banco.fila.where('registroId').equals(registroId).first()
    if (pendente === undefined) {
      await banco.fila.add({ tabela, registroId, criadoEm: instante, versao: 0 })
      return
    }
    await banco.fila.update(pendente.ordem, { versao: (pendente.versao ?? 0) + 1, problema: undefined })
  }

  return {
    listarClientes: () => banco.clientes.toArray(),
    lerCliente: (id) => banco.clientes.get(id),
    lerFicha: (clienteId) => banco.lancamentos.where('clienteId').equals(clienteId).toArray(),
    gravarCliente: async (cliente) => {
      // Um instante por gravação: é o carimbo do último-que-escreve (relógio do aparelho,
      // D-010, D-042) e o `criadoEm` da fila.
      const instante = agora()
      await banco.transaction('rw', banco.clientes, banco.fila, async () => {
        await banco.clientes.put({ ...cliente, atualizadoEm: instante })
        await enfileirar('clientes', cliente.id, instante)
      })
      aoEnfileirar()
    },
    gravarLancamento: async (lancamento) => {
      const instante = agora()
      await banco.transaction('rw', banco.lancamentos, banco.fila, async () => {
        await banco.lancamentos.put(lancamento)
        await enfileirar('lancamentos', lancamento.id, instante)
      })
      aoEnfileirar()
    },
    sincronizado: async (id) => (await banco.fila.where('registroId').equals(id).count()) === 0,
    comProblema: async (id) => (await banco.fila.where('registroId').equals(id).first())?.problema !== undefined,
  }
}
