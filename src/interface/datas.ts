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

/**
 * O dia de hoje pelo relógio do aparelho, montado campo a campo — `toISOString()` passaria
 * pelo UTC e, depois das 21h em Brasília, diria "amanhã" (regra herdada do protótipo de E-02).
 */
export function hoje(relogio: Date = new Date()): Dia {
  return `${relogio.getFullYear()}-${doisDigitos(relogio.getMonth() + 1)}-${doisDigitos(relogio.getDate())}`
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
