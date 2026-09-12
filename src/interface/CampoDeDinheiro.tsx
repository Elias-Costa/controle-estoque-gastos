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
}: {
  rotulo: string
  texto: string
  aoMudar: (texto: string) => void
}) {
  const id = useId()
  const lido = lerDinheiro(texto)
  const vazio = texto.trim() === ''
  return (
    <>
      <Rotulo para={id}>{rotulo}</Rotulo>
      <div className="flex items-center gap-2 rounded-xl border border-borda bg-papel px-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acento">
        <span className="text-2xl text-suave">R$</span>
        <input
          id={id}
          className="min-h-16 w-full border-0 bg-transparent text-[2.25rem] leading-none font-bold text-tinta tabular-nums outline-none"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={texto}
          onChange={(evento) => aoMudar(evento.target.value)}
        />
      </div>
      {/* A leitura do domínio, grande, enquanto ela digita (D-034). Some quando o campo está vazio. */}
      {!vazio && (
        <p className={`m-0 mt-1.5 text-[1.25rem] font-semibold tabular-nums ${lido === null ? 'text-atraso' : 'text-suave'}`}>
          {lido === null ? 'Não entendi o valor' : emReais(lido)}
        </p>
      )}
    </>
  )
}
