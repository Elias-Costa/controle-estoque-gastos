import type { Dia } from '../dominio/ficha.ts'

/**
 * Datas na borda da tela: o que o domínio recebe e devolve é `Dia` (`AAAA-MM-DD`, RN-09);
 * aqui mora só a tradução entre esse texto, o relógio do aparelho e o que ela lê ("28/09").
 *
 * `number` é legítimo neste arquivo — conta dias, nunca dinheiro (a guarda de EL-03 fica no
 * domínio, `src/interface/LEIA-ME.md`).
 */

/** Dois dígitos: `5` → `"05"`. */
const doisDigitos = (valor: number): string => String(valor).padStart(2, '0')

/** Um `Date` local vira `Dia`, campo a campo — nunca por `toISOString()`, que passa pelo UTC. */
function comoDia(data: Date): Dia {
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`
}

/** Os três campos de um `Dia`, como números: ano, mês (1–12), dia. */
function campos(dia: Dia): [number, number, number] {
  const [ano, mes, d] = dia.split('-').map(Number)
  return [ano ?? 0, mes ?? 1, d ?? 1]
}

/**
 * O dia de hoje pelo relógio do aparelho, montado campo a campo — `toISOString()` passaria
 * pelo UTC e, depois das 21h em Brasília, diria "amanhã" (regra herdada do protótipo de E-02).
 */
export function hoje(relogio: Date = new Date()): Dia {
  return comoDia(relogio)
}

/** `dia` deslocado N dias pelo calendário local; negativo é passado. "Ontem" na venda é `diasDepois(hoje(), -1)`. */
export function diasDepois(dia: Dia, quantidade: number): Dia {
  const [ano, mes, d] = campos(dia)
  return comoDia(new Date(ano, mes - 1, d + quantidade))
}

/**
 * `dia` deslocado N meses, **preso ao último dia** quando o mês é mais curto: 31/01 + 1 é
 * 28/02, não 03/03 (o estouro natural do `Date`, que ela leria como erro — regra do protótipo).
 * É a sugestão mensal das parcelas (RF-05).
 */
export function mesesDepois(dia: Dia, quantidade: number): Dia {
  const [ano, mes, d] = campos(dia)
  const alvo = new Date(ano, mes - 1 + quantidade, 1)
  const ultimoDoMes = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate()
  alvo.setDate(d < ultimoDoMes ? d : ultimoDoMes)
  return comoDia(alvo)
}

/** `"2026-09-28"` → `"28/09"`: como ela escreve a data na fichinha. */
export function diaCurto(dia: Dia): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`
}

/** Dias inteiros de `de` até `ate`; negativo quando `ate` vem antes. Em UTC, para o horário de verão não somar hora. */
export function diasEntre(de: Dia, ate: Dia): number {
  const [anoDe, mesDe, diaDe] = de.split('-').map(Number)
  const [anoAte, mesAte, diaAte] = ate.split('-').map(Number)
  const inicio = Date.UTC(anoDe ?? 0, (mesDe ?? 1) - 1, diaDe ?? 1)
  const fim = Date.UTC(anoAte ?? 0, (mesAte ?? 1) - 1, diaAte ?? 1)
  return Math.round((fim - inicio) / 86_400_000)
}

/** Há quantos dias a parcela venceu; `0` se vence hoje ou ainda vai vencer. RF-10: "há quantos dias". */
export function diasDeAtraso(vencimento: Dia, referencia: Dia): number {
  const dias = diasEntre(vencimento, referencia)
  return dias > 0 ? dias : 0
}

/**
 * O que ela escolheu em "Quando foi" (venda e recebimento): as duas opções do protótipo e a
 * de RN-09, que abre o campo de data (D-045). `outroDia` só conta quando `escolha` é
 * `'outro'`; fica guardado para a data não sumir se ela tocar "Hoje" e voltar.
 */
export type Quando = {
  readonly escolha: 'hoje' | 'ontem' | 'outro'
  readonly outroDia: Dia
}

/**
 * Hoje, ontem ou outro dia, a partir de uma data já gravada — ou hoje, quando não há nenhuma.
 * Sem data gravada, "Outro dia" já vem com a última que ela digitou nesta sessão (`lembrado`,
 * D-049 item 1): na migração ela ajusta o dia em vez de digitar a data inteira. O padrão
 * continua "Hoje" (RN-09); a lembrança só preenche o campo que ela abre.
 */
export function quandoDe(data: Dia | undefined, hoje: Dia, lembrado: Dia = ''): Quando {
  if (data === undefined) return { escolha: 'hoje', outroDia: lembrado }
  if (data === hoje) return { escolha: 'hoje', outroDia: '' }
  if (data === diasDepois(hoje, -1)) return { escolha: 'ontem', outroDia: '' }
  return { escolha: 'outro', outroDia: data }
}

/** A data que a escolha significa. `''` quando é "Outro dia" e ela ainda não escolheu qual — a guarda `falta-a-data` cobre. */
export function diaDoQuando(quando: Quando, hoje: Dia): Dia {
  if (quando.escolha === 'hoje') return hoje
  if (quando.escolha === 'ontem') return diasDepois(hoje, -1)
  return quando.outroDia
}
