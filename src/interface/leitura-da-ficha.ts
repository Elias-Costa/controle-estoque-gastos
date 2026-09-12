import type { Centavos } from '../dominio/dinheiro.ts'
import {
  historico,
  parcelas,
  saldo,
  situacaoDaParcela,
  type Cliente,
  type Dia,
  type Ficha,
  type Id,
  type Lancamento,
} from '../dominio/ficha.ts'
import { diasDeAtraso } from './datas.ts'
import { descricaoDoLancamento, nomeDaParcela } from './palavras-da-ficha.ts'

/**
 * O que a lista e a ficha mostram, derivado da ficha do domínio — puro, sem React, testável
 * no `bun test` (`testes/leitura-da-ficha.test.ts`). Nenhum número daqui é guardado: saldo,
 * próxima parcela e situação vêm de `saldo`, `parcelas` e `situacaoDaParcela` (RN-01, RF-02).
 * `hoje` é parâmetro para o teste fixar o dia; a tela passa `hoje()` de `datas.ts`.
 */

/** A próxima parcela como a tela precisa dela: quanto falta, quando vence, se já venceu. */
export type ProximaParcela = {
  readonly restante: Centavos
  readonly vencimento: Dia
  readonly vencida: boolean
}

/** Uma linha da lista de fichinhas (RF-10 em versão de E-09: quem deve, quanto, há quantos dias). */
export type ResumoDaFicha = {
  readonly cliente: Cliente
  readonly saldo: Centavos
  readonly proxima: ProximaParcela | null
  /** `0` quando não há parcela vencida. */
  readonly diasDeAtraso: number
  /** Sem lançamento nenhum — a ficha diz "Não deve nada" e não "Está tudo pago". */
  readonly vazia: boolean
}

/** Resume a ficha de uma cliente para a lista e para o cartão do topo. */
export function resumir(cliente: Cliente, ficha: Ficha, hoje: Dia): ResumoDaFicha {
  const aberta = parcelas(ficha).find((parcela) => parcela.restante > 0n)
  const proxima: ProximaParcela | null =
    aberta === undefined
      ? null
      : {
          restante: aberta.restante,
          vencimento: aberta.parcela.vencimento,
          vencida: situacaoDaParcela(aberta, hoje) === 'vencida',
        }
  return {
    cliente,
    saldo: saldo(ficha),
    proxima,
    diasDeAtraso: proxima?.vencida ? diasDeAtraso(proxima.vencimento, hoje) : 0,
    vazia: ficha.length === 0,
  }
}

/**
 * Deixa o texto comparável: minúsculas e sem acento. Sem isto, "cla" não encontra "Cláudia" e
 * "salao" não encontra "do salão" — e a lista volta vazia no meio de uma tarefa cronometrada,
 * que ela leria como "essa cliente não está aqui" (achado da revisão do protótipo, 2026-09-05).
 * A faixa ̀-ͯ é a dos diacríticos que o NFD separa da letra; escapada porque os
 * caracteres literais são invisíveis num editor.
 */
export function semAcento(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** A lista como ela vê: filtrada pela busca (nome ou apelido) e em ordem alfabética (D-044). */
export function filtrarEOrdenar(resumos: readonly ResumoDaFicha[], busca: string): ResumoDaFicha[] {
  const termo = semAcento(busca.trim())
  return resumos
    .filter(
      ({ cliente }) => semAcento(cliente.nome).includes(termo) || semAcento(cliente.apelido ?? '').includes(termo),
    )
    .sort((a, b) => a.cliente.nome.localeCompare(b.cliente.nome, 'pt-BR'))
}

/**
 * Uma linha do histórico da ficha. `chave` é estável para o React; `valor` é sempre positivo — a
 * descrição diz o sentido. `lancamentoId` só existe na linha que **abre a anotação** (E-10,
 * D-045): a venda ainda não desfeita. Recebimento entra em E-11; saldo anterior, em E-14.
 */
export type LinhaDaFicha = {
  readonly chave: string
  readonly data: Dia
  readonly descricao: string
  readonly valor: Centavos
  readonly tipo: 'vencida' | 'a-vencer' | 'evento' | 'pagamento'
  readonly estornado: boolean
  readonly lancamentoId?: Id
}

/**
 * As linhas da ficha, em ordem cronológica inversa (RF-02).
 *
 * Entram as parcelas **em aberto** (pela data de vencimento) e o que já aconteceu (o que ela
 * levou, o que pagou). Parcela quitada não vira linha própria: quem a representa é o
 * recebimento correspondente, e mostrar as duas encheria a ficha de linhas repetidas (regra
 * do protótipo, validada na sessão). Estorno é linha própria e o alvo continua, marcado (RN-07).
 */
export function linhasDaFicha(ficha: Ficha, hoje: Dia): LinhaDaFicha[] {
  const porId = new Map<Id, Lancamento>(ficha.map((lancamento): [Id, Lancamento] => [lancamento.id, lancamento]))

  const deParcelas: LinhaDaFicha[] = parcelas(ficha)
    .filter((parcela) => parcela.restante > 0n)
    .map((parcela) => ({
      chave: `parcela:${parcela.parcela.id}`,
      data: parcela.parcela.vencimento,
      descricao: nomeDaParcela(
        parcela.debito.parcelas.findIndex((p) => p.id === parcela.parcela.id) + 1,
        parcela.debito.parcelas.length,
      ),
      valor: parcela.restante,
      tipo: situacaoDaParcela(parcela, hoje) === 'vencida' ? 'vencida' : 'a-vencer',
      estornado: false,
    }))

  const deEventos: LinhaDaFicha[] = historico(ficha).map(({ lancamento, valor, estornado }) => ({
    chave: `lancamento:${lancamento.id}`,
    data: lancamento.data,
    descricao: descricaoDoLancamento(
      lancamento,
      lancamento.tipo === 'estorno' ? porId.get(lancamento.estornaId) : undefined,
    ),
    valor,
    tipo: lancamento.tipo === 'recebimento' || lancamento.tipo === 'desconto-quitacao' ? 'pagamento' : 'evento',
    estornado,
    ...(lancamento.tipo === 'venda' && !estornado && { lancamentoId: lancamento.id }),
  }))

  // Ordenação estável: no mesmo dia, parcela antes de evento — como o protótipo.
  return [...deParcelas, ...deEventos].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0))
}
