import { useId } from 'react'
import { emReais, lerDinheiro } from '../dominio/dinheiro.ts'
import { Rotulo } from './Campo.tsx'

/**
 * O campo de dinheiro do kit (D-023, D-034): ela digita como quiser — `1250` é R$ 12,50,
 * `12,5` é R$ 12,50, `1.250` é R$ 1.250,00 — e quem lê é `lerDinheiro`, no domínio. Esta
 * borda não interpreta nada: mostra, **grande e enquanto ela digita**, o valor que o domínio
 * leu, para R$ 0,25 ser visível antes de confirmar (D-034). Quando o domínio não lê
 * (`39,905`, letras), a linha diz que não entendeu — guarda visível antes do toque, nunca
 * botão que não faz nada (lição de E-02).
 *
 * O texto cru fica com a tela, que decide o que fazer com o `Centavos` lido. `number` não
 * entra aqui em lugar nenhum (EL-03).
 */
export function CampoDeDinheiro({
  rotulo,
  texto,
  aoMudar,
  selecionarAoFocar = false,
}: {
  rotulo: string
  texto: string
  aoMudar: (texto: string) => void
  /** Para o campo que já vem preenchido (o recebimento, D-006): tocar e digitar substitui, sem apagar antes. */
  selecionarAoFocar?: boolean
}) {
  const id = useId()
  return (
    <>
      <Rotulo para={id}>{rotulo}</Rotulo>
      <div className="flex items-center gap-2 rounded-xl border border-borda bg-papel px-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acento">
        <span className="text-2xl text-suave">R$</span>
        <EntradaDeDinheiro
          id={id}
          className="min-h-16 w-full border-0 bg-transparent text-[2.25rem] leading-none font-bold text-tinta tabular-nums outline-none"
          texto={texto}
          aoMudar={aoMudar}
          selecionarAoFocar={selecionarAoFocar}
        />
      </div>
      <LeituraDoValor texto={texto} className="mt-1.5 text-[1.25rem]" />
    </>
  )
}

/**
 * Só a entrada, sem rótulo nem leitura: para os lugares em que o campo é compacto — o preço
 * de cada item e o valor de cada parcela na venda (E-10). O teclado é o decimal (D-034).
 */
export function EntradaDeDinheiro({
  texto,
  aoMudar,
  className,
  id,
  exemplo,
  rotuloAcessivel,
  selecionarAoFocar = false,
}: {
  texto: string
  aoMudar: (texto: string) => void
  className: string
  id?: string
  exemplo?: string
  rotuloAcessivel?: string
  selecionarAoFocar?: boolean
}) {
  return (
    <input
      id={id}
      className={className}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      placeholder={exemplo}
      aria-label={rotuloAcessivel}
      value={texto}
      onChange={(evento) => aoMudar(evento.target.value)}
      onFocus={selecionarAoFocar ? (evento) => evento.target.select() : undefined}
    />
  )
}

/** A leitura do domínio para o que ela digitou (D-034). Some quando o campo está vazio. */
export function LeituraDoValor({ texto, className }: { texto: string; className: string }) {
  if (texto.trim() === '') return null
  const lido = lerDinheiro(texto)
  return (
    <p className={`m-0 font-semibold tabular-nums ${lido === null ? 'text-atraso' : 'text-suave'} ${className}`}>
      {lido === null ? 'Não entendi o valor' : emReais(lido)}
    </p>
  )
}
