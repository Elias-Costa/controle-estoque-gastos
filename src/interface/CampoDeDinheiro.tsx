import { useId, type MouseEvent } from 'react'
import { Rotulo } from './Campo.tsx'
import { aplicarMascara } from './mascara-de-dinheiro.ts'

/** O que o campo mostra vazio: o `0,00` da maquininha. É placeholder — nada digitado não é um valor (D-051). */
const EXEMPLO = '0,00'

/**
 * O campo de dinheiro do kit (D-023, D-051): máscara pela direita, como na maquininha. O campo
 * mostra `0,00`; ela digita `5` → `0,05`, `2` → `0,52`, `7` → `5,27`, `0` → `52,70`; apagar tira
 * o último dígito. Nunca há vírgula para teclar — o teclado é o numérico. O que está no campo
 * **é** o valor, grande, a cada tecla: se ela digitar `25` esperando R$ 25,00, o `0,25` está na
 * cara dela antes de confirmar. (Substituiu o híbrido de D-034 em 2026-09-18.)
 *
 * O texto formatado fica com a tela, que o lê por `lerDinheiro` no domínio e decide o que
 * fazer com o `Centavos`. `number` não entra aqui em lugar nenhum (EL-03).
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
    </>
  )
}

/**
 * Só a entrada, sem rótulo: para os lugares em que o campo é compacto — o preço de cada item e
 * o valor de cada parcela na venda (E-10). A máscara é a mesma (`aplicarMascara`): o `onChange`
 * recebe o texto como ficou depois da tecla e devolve à tela o texto formatado. O caret vai
 * para o fim quando ela toca no meio do texto (a máscara só faz sentido pela direita), exceto
 * quando o texto inteiro está selecionado — é o toque que substitui (`selecionarAoFocar`).
 */
export function EntradaDeDinheiro({
  texto,
  aoMudar,
  className,
  id,
  exemplo = EXEMPLO,
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
  function caretNoFim(evento: MouseEvent<HTMLInputElement>): void {
    const campo = evento.currentTarget
    const tudoSelecionado = campo.selectionStart === 0 && campo.selectionEnd === campo.value.length && campo.value.length > 0
    if (!tudoSelecionado) campo.setSelectionRange(campo.value.length, campo.value.length)
  }
  return (
    <input
      id={id}
      className={className}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={exemplo}
      aria-label={rotuloAcessivel}
      value={texto}
      onChange={(evento) => aoMudar(aplicarMascara(evento.target.value))}
      onClick={caretNoFim}
      onFocus={selecionarAoFocar ? (evento) => evento.target.select() : undefined}
    />
  )
}
