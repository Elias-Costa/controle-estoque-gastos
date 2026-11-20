import type { Dia } from './ficha.ts'
import { diaValido } from './regras-estoque.ts'

/** Dias entre datas civis, sem influência do fuso ou do horário de verão. */
export function diasCivisEntre(de: Dia, ate: Dia): number {
  return (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000
}

/** Mês civil deslocado, inclusive na virada de ano. A entrada já foi validada. */
export function deslocarMes(mes: string, deslocamento: number): string {
  const data = new Date(`${mes}-01T00:00:00Z`)
  data.setUTCMonth(data.getUTCMonth() + deslocamento)
  return data.toISOString().slice(0, 7)
}

/** Quantidade de dias de um mês civil válido, inclusive fevereiro bissexto. */
export function diasDoMes(mes: string): number {
  return diasCivisEntre(`${mes}-01`, `${deslocarMes(mes, 1)}-01`)
}

/** Monta a data civil a partir do mês e de um dia que pertence a ele. */
export function diaDoMes(mes: string, dia: number): Dia {
  return `${mes}-${String(dia).padStart(2, '0')}`
}

/** O Resumo recebe um dia explícito e permite consultar o mês atual ou meses encerrados. */
export function conferirPeriodo(hoje: Dia, mes: string): void {
  if (!diaValido(hoje) || !diaValido(`${mes}-01`) || mes > hoje.slice(0, 7) ||
    new Date(`${hoje}T00:00:00Z`).toISOString().slice(0, 10) !== hoje) throw new RangeError('Período inválido')
}
