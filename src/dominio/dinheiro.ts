/**
 * Dinheiro do domínio: `bigint` de centavos (D-022, RN-10, RI-01).
 *
 * Dois tipos convivem aqui e o compilador não deixa que se misturem, e isso é a
 * guarda mais forte contra EL-03:
 *
 * - **Dinheiro é `bigint`** (`Centavos`). `total / 3n` é divisão inteira com o resto
 *   visível; `total * 0.9` não compila.
 * - **Contagem é `number`** (número de parcelas, quantidade de itens). `preco + quantidade`
 *   não compila, então um valor em centavos nunca é somado a uma contagem por engano.
 *   A única conversão acontece em `contagem()`, aqui dentro, com validação.
 *
 * Soma, subtração e comparação de **dois** valores são os operadores nativos (`+`, `-`,
 * `<`, `>`, `===`) — foi exatamente por eles que D-022 escolheu `bigint` em vez de uma
 * classe ou de uma biblioteca decimal. As funções deste arquivo existem onde o operador
 * não basta: soma de lista, produto por quantidade, repartição em parcelas, leitura do
 * que ela digita e formatação em pt-BR.
 *
 * Nada de `number` no caminho monetário: `parseFloat`, `Number`, `Math` e `.toFixed()` são
 * reprovados pelo lint nesta pasta (`.oxlintrc.json`), e `testes/guarda-dinheiro.test.ts`
 * prova que a reprovação funciona. Os testes deste módulo estão em `testes/dinheiro.test.ts`
 * (RT-01).
 */

/**
 * Valor em centavos, inteiro. R$ 39,90 é `3990n`.
 *
 * É um apelido de `bigint`, não um invólucro, de propósito: os operadores nativos são a
 * aritmética e a comparação, e um invólucro perderia justamente a proteção do compilador
 * que D-022 comprou. Pode ser negativo — lucro (RN-11) pode ser prejuízo —, mas nada que
 * ela digita produz valor negativo (`lerDinheiro`).
 */
export type Centavos = bigint

/**
 * Converte uma contagem (`number`) em `bigint`, validando que é inteira e não fica abaixo
 * do mínimo. `BigInt(1.5)`, `BigInt(NaN)` e `BigInt(Infinity)` lançam `RangeError` sozinhos,
 * e é essa a verificação de "inteiro" — `Number.isInteger` é banido nesta pasta.
 */
function contagem(valor: number, minimo: bigint, nome: string): bigint {
  let inteiro: bigint
  try {
    inteiro = BigInt(valor)
  } catch {
    throw new RangeError(`${nome} precisa ser um número inteiro; recebeu ${valor}`)
  }
  if (inteiro < minimo) {
    throw new RangeError(`${nome} precisa ser no mínimo ${minimo}; recebeu ${valor}`)
  }
  return inteiro
}

/**
 * Soma uma lista de valores. Lista vazia soma `0n`.
 *
 * Existe porque `reduce` sem valor inicial lança na lista vazia, e `0` no lugar de `0n`
 * é o erro fácil de cometer e difícil de ver. É a forma que RN-01 toma em E-04:
 * `saldo = somar(débitos) - somar(recebimentos)`.
 */
export function somar(valores: Iterable<Centavos>): Centavos {
  let total = 0n
  for (const valor of valores) total += valor
  return total
}

/**
 * Preço unitário × quantidade. Exato por construção: inteiro × inteiro (D-022).
 * `vezes` precisa ser inteiro e não negativo; zero é permitido e dá `0n`.
 */
export function multiplicar(valor: Centavos, vezes: number): Centavos {
  return valor * contagem(vezes, 0n, 'quantidade')
}

/**
 * Reparte um total em `vezes` parcelas sem perder centavo: a soma é sempre igual ao total.
 *
 * Regra (D-012 + D-030): **todas as parcelas menos a primeira são múltiplos de 5 centavos**,
 * porque ela recebe 8 em 10 em dinheiro vivo e o troco anda de 5 em 5; **a primeira carrega
 * a diferença**, e é a única que pode não ser múltiplo de 5 — quando o total não é.
 *
 *   R$ 64,90 em 3× → 21,70 / 21,60 / 21,60
 *   R$ 100,00 em 3× → 33,40 / 33,30 / 33,30
 *   R$ 0,01 em 2× → 0,01 / 0,00
 *
 * A parcela comum é o **piso** ao múltiplo de 5, não o mais próximo: com o mais próximo,
 * R$ 100,00 daria 33,35 nas demais e 33,30 na primeira — a primeira ficaria menor, e o
 * que D-012 decidiu é que ela é a mais pesada. Com o piso, a primeira é sempre maior ou
 * igual às outras, e a diferença fica abaixo de 5 centavos por parcela.
 *
 * O valor que ela edita à mão depois (D-012) não passa por aqui e não precisa ser
 * múltiplo de nada; manter a soma igual ao total é operação de E-04.
 */
export function repartir(total: Centavos, vezes: number): Centavos[] {
  const quantidade = contagem(vezes, 1n, 'número de parcelas')
  if (total < 0n) {
    throw new RangeError(`não há o que repartir em total negativo: ${emReais(total)}`)
  }
  // Divisão inteira de bigint: o resto some aqui e volta inteiro na primeira parcela.
  const comum = ((total / quantidade) / 5n) * 5n
  const primeira = total - comum * (quantidade - 1n)
  const parcelas: Centavos[] = [primeira]
  for (let i = 1; i < vezes; i += 1) parcelas.push(comum)
  return parcelas
}

/** Só dígitos: `3990`, `25`. Preenche pela direita — são centavos (D-034). */
const SO_DIGITOS = /^\d+$/
/** Com separador decimal: `39,90`, `39.9`, `25,`, `,50`. Lê literal (D-034). */
const COM_DECIMAL = /^(\d*)[,.](\d{0,2})$/
/** Com ponto de milhar em pt-BR: `1.250`, `1.250,00`, `1.250.000`. Lê como reais (D-034, emenda). */
const COM_MILHAR = /^(\d{1,3}(?:\.\d{3})+)(?:[,.](\d{0,2}))?$/

/**
 * Lê o que ela digitou e devolve centavos, ou `null` quando o texto não é um valor.
 *
 * Regra de D-034, híbrida, decidida sabendo que contraria uma das duas teclas observadas
 * na sessão de 2026-09-08 (ela digitou `39,90` e `25`):
 *
 * - **Sem separador, preenche pela direita:** `3990` → R$ 39,90; `25` → R$ 0,25. É o que
 *   a maquininha faz e custa uma tecla a menos por valor (RNF-02). O campo mostra o valor
 *   formatado grande enquanto ela digita, para que R$ 0,25 não passe em silêncio (E-10).
 * - **Com vírgula (ou ponto decimal), lê literal:** `39,90` → R$ 39,90; `39,9` → R$ 39,90;
 *   `25,` → R$ 25,00. Ponto é tratado como vírgula porque não se sabe qual tecla o teclado
 *   do iPhone dela mostra (verificar em E-09, não afirmar).
 * - **Ponto seguido de exatamente três dígitos é milhar**, e o texto é lido como reais:
 *   `1.250` → R$ 1.250,00. Descartar o ponto e preencher pela direita daria R$ 12,50 — o
 *   erro de 100× que D-034 existe para impedir (emenda de 2026-09-11).
 * - **Mais de duas casas depois do separador não é lido:** `39,905` → `null`. Não tem
 *   leitura exata em centavos, e truncar descartaria um dígito em silêncio; a tela mostra
 *   que não leu e ela apaga a tecla a mais (emenda de 2026-09-11).
 *
 * `null` é "não é um valor" — texto vazio, letras, sinal de menos, dois separadores. É a
 * tela que decide como mostrar isso, e a lição de E-02 vale: guarda visível antes do
 * toque, nunca botão que não faz nada.
 */
export function lerDinheiro(texto: string): Centavos | null {
  const limpo = texto.trim()
  if (SO_DIGITOS.test(limpo)) return BigInt(limpo)

  const decimal = COM_DECIMAL.exec(limpo)
  if (decimal) return centavosDe(decimal[1] ?? '', decimal[2] ?? '')

  const milhar = COM_MILHAR.exec(limpo)
  if (milhar) return centavosDe((milhar[1] ?? '').replaceAll('.', ''), milhar[2] ?? '')

  return null
}

/** Monta centavos a partir da parte em reais e da fração já validadas pelos padrões acima. */
function centavosDe(reais: string, fracao: string): Centavos {
  // `9` depois da vírgula é R$ 0,90, não R$ 0,09: a fração completa à direita até duas casas.
  const centavos = (fracao + '00').slice(0, 2)
  return BigInt(reais || '0') * 100n + BigInt(centavos)
}

/**
 * Formata centavos em pt-BR: `123456n` → `"R$ 1.234,56"`; negativo → `"-R$ 1,50"`.
 *
 * Feito à mão, sem `Intl`, de propósito: `Intl.NumberFormat` formata um `bigint` como
 * inteiro (não escala centavos) e emite espaço não separável, que confunde teste e
 * comparação. Oito linhas explícitas são mais baratas de manter do que essa borda.
 */
export function emReais(centavos: Centavos): string {
  const negativo = centavos < 0n
  const absoluto = negativo ? -centavos : centavos
  // Ponto de milhar da direita para a esquerda: 1234567 → 1.234.567
  const reais = (absoluto / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const fracao = (absoluto % 100n).toString().padStart(2, '0')
  return `${negativo ? '-' : ''}R$ ${reais},${fracao}`
}
