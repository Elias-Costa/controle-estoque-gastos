/**
 * A base local no aparelho: IndexedDB via Dexie (D-020), com as tabelas da ficha e a fila de
 * sincronização (E-05). É aqui, e só aqui, que o esquema é declarado.
 *
 * Três escolhas atravessam este arquivo, todas em D-040:
 *
 * - **A linha é o tipo do domínio, sem mapeamento.** `clientes` guarda `Cliente`;
 *   `lancamentos` guarda `Lancamento` como `ficha.ts` o define — parcelas e itens dentro,
 *   `bigint` como está. Não há campo de saldo (D-039), não há `sincronizado` (a fila é a
 *   fonte, D-013), não há `atualizadoEm` (E-07 acrescenta o que precisar sem migração,
 *   porque em Dexie só índice é esquema).
 * - **Dinheiro não entra em índice.** `BigInt` não é chave válida em IndexedDB: guardar
 *   pode, indexar não (D-022). Todo índice deste arquivo está numa lista de permissão em
 *   `testes/banco.test.ts` — porque o IndexedDB de mentira dos testes **aceita** `bigint`
 *   como chave, e um teste comportamental não pegaria o erro.
 * - **A fila é ponteiro, não cópia.** Um item diz qual linha de qual tabela precisa subir; o
 *   que sobe é a linha como estiver no momento do envio. Correção no lugar (D-013) reescreve
 *   a linha e a fila já aponta para ela. A ordem é autoincremento local, porque UUIDv7 e
 *   `Date.now()` empatam no mesmo milissegundo e a fila precisa de FIFO garantido.
 *
 * **Protocolo de migração** (D-020: o app evolui no aparelho dela sem reinstalação):
 *
 * 1. **Nunca edite uma versão publicada.** `ESQUEMA_V1` é o que já existe nos aparelhos;
 *    `testes/banco.test.ts` guarda uma cópia literal e fica vermelho se este arquivo divergir.
 * 2. Para mudar índice ou formato de linha, **acrescente** `this.version(2).stores({...})`
 *    abaixo da v1, com `.upgrade((tx) => ...)` quando as linhas existentes precisarem mudar
 *    de forma. Dexie roda os `upgrade` em ordem, da versão que o aparelho tem até a atual.
 * 3. Acrescentar campo **não indexado** não é migração: a linha nova tem o campo, a antiga
 *    não, e o código lê as duas.
 * 4. A base é aberta na abertura do app (`main.tsx`), então a migração roda ali — não no
 *    meio de uma venda.
 */

import Dexie, { type DexieOptions, type Table } from 'dexie'
import type { Cliente, Id, Lancamento } from '../dominio/ficha.ts'

/**
 * O nome da base no aparelho. **Escolhido uma vez, nunca muda** (D-040): o IndexedDB é
 * identificado pela origem e por este nome, e mudar qualquer um dos dois depois de instalado
 * é começar do zero no aparelho dela — o dado *parece* perdido (falso EL-05, ver D-026).
 */
export const NOME_DO_BANCO = 'controle-fiado'

/** As tabelas que sobem para a nuvem. A fila não sobe: é só deste aparelho. */
export type TabelaSincronizada = 'clientes' | 'lancamentos'

/**
 * Um item da fila de sincronização: "a linha `registroId` de `tabela` precisa subir".
 * Há no máximo um item pendente por registro (`repositorio.ts`). `criadoEm` é informativo —
 * para o indicador de RF-25 e para diagnóstico —, não é chave nem ordem.
 */
export type ItemDaFila = {
  /** Autoincremento local: a ordem de entrada é a ordem de envio. */
  readonly ordem: number
  readonly tabela: TabelaSincronizada
  readonly registroId: Id
  /** Instante em que entrou na fila, ISO 8601. */
  readonly criadoEm: string
}

/** O que entra na fila: tudo menos a ordem, que o banco atribui. */
export type NovoItemDaFila = Omit<ItemDaFila, 'ordem'>

/**
 * Versão 1 do esquema, **publicada**: só chaves e índices, nunca campos. Não edite; acrescente
 * uma versão (ver o protocolo no topo). `id` é a chave de idempotência (D-029); `clienteId` é
 * o índice que monta a ficha; a fila ordena por `++ordem` e procura por `registroId`.
 */
export const ESQUEMA_V1 = {
  clientes: 'id',
  lancamentos: 'id, clienteId',
  fila: '++ordem, registroId',
} as const

/**
 * A base local. `dependencias` existe para os testes injetarem um IndexedDB de mentira
 * isolado por teste (`fake-indexeddb`); em produção ninguém passa nada e o Dexie usa o do
 * navegador. As tabelas vêm de `this.table(...)`, que é o registro do próprio Dexie — sem
 * `as` e sem `!` (AGENTS.md §4).
 */
export class BancoLocal extends Dexie {
  readonly clientes: Table<Cliente, Id, Cliente>
  readonly lancamentos: Table<Lancamento, Id, Lancamento>
  readonly fila: Table<ItemDaFila, number, NovoItemDaFila>

  constructor(nome: string = NOME_DO_BANCO, dependencias?: DexieOptions) {
    super(nome, dependencias)
    this.version(1).stores(ESQUEMA_V1)
    this.clientes = this.table('clientes')
    this.lancamentos = this.table('lancamentos')
    this.fila = this.table('fila')
  }
}
