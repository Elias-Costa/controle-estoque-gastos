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
}

/**
 * O repositório sobre a base local. `agora` é o relógio para o `criadoEm` da fila; é
 * parâmetro só para os testes fixarem o instante.
 */
export function criarRepositorioLocal(
  banco: BancoLocal,
  agora: () => string = () => new Date().toISOString(),
): Repositorio {
  /**
   * No máximo um item pendente por registro (D-040): se a linha já está na fila, regravá-la
   * antes de subir não cria um segundo item — o que sobe é a linha como estiver na hora do
   * envio. Chamada sempre de dentro da transação de gravação.
   */
  async function enfileirar(tabela: TabelaSincronizada, registroId: Id): Promise<void> {
    const pendente = await banco.fila.where('registroId').equals(registroId).first()
    if (pendente === undefined) await banco.fila.add({ tabela, registroId, criadoEm: agora() })
  }

  return {
    listarClientes: () => banco.clientes.toArray(),
    lerCliente: (id) => banco.clientes.get(id),
    lerFicha: (clienteId) => banco.lancamentos.where('clienteId').equals(clienteId).toArray(),
    gravarCliente: (cliente) =>
      banco.transaction('rw', banco.clientes, banco.fila, async () => {
        await banco.clientes.put(cliente)
        await enfileirar('clientes', cliente.id)
      }),
    gravarLancamento: (lancamento) =>
      banco.transaction('rw', banco.lancamentos, banco.fila, async () => {
        await banco.lancamentos.put(lancamento)
        await enfileirar('lancamentos', lancamento.id)
      }),
  }
}
