import type { Centavos } from '../dominio/dinheiro.ts'

/** Barras de D-024. O conteúdo equivalente, com valores exatos, acompanha o SVG em HTML. */
export function GraficoDoResumo({ valores }: { valores: readonly (Centavos | undefined)[] }) {
  let menor = 0n
  let maior = 0n
  for (const valor of valores) {
    if (valor === undefined) continue
    if (valor < menor) menor = valor
    if (valor > maior) maior = valor
  }

  // Em milésimos da altura do desenho. Só o resultado sem unidade monetária vira number (RI-01).
  const amplitude = maior - menor
  const y = (valor: Centavos) => amplitude === 0n ? 500 : 1000 - Number((valor - menor) * 1000n / amplitude)
  const zero = y(0n)
  const passo = 1000 / valores.length

  return <svg aria-hidden="true" viewBox="0 -14 1000 1028" preserveAspectRatio="none" className="block h-24 w-full">
    <line x1="0" x2="1000" y1={zero} y2={zero} className="stroke-contorno" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    {valores.map((valor, i) => {
      if (valor === undefined) return null
      const altura = Math.max(14, Math.abs(y(valor) - zero))
      return <rect key={i} x={(i + 0.15) * passo} width={0.7 * passo}
        y={valor < 0n ? zero : valor > 0n ? zero - altura : zero - 7} height={altura}
        className={valor < 0n ? 'fill-atraso' : valor > 0n ? 'fill-acento' : 'fill-contorno'} />
    })}
  </svg>
}
