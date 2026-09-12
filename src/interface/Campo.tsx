import { useId } from 'react'

/** As classes de todo campo de texto do kit: 52 px, borda, papel, e o foco em verde. */
export const CLASSES_DE_CAMPO =
  'w-full min-h-[52px] rounded-xl border border-borda bg-papel px-3 text-tinta focus:outline-2 focus:outline-offset-2 focus:outline-acento'

/** O rótulo acima de um campo, em cinza, com o espaço do protótipo. */
export function Rotulo({ para, children }: { para?: string; children: string }) {
  return (
    <label htmlFor={para} className="mt-5 mb-1.5 block text-[0.95rem] text-suave">
      {children}
    </label>
  )
}

/**
 * Campo de texto, telefone ou data do kit (D-023). Uma linha por padrão; `multilinha` para a
 * observação. `autoFoco` só no primeiro campo obrigatório de uma tela — o teclado do iPhone
 * abrir sozinho ao entrar na tela é um toque a menos (RNF-02), **se abrir**: foco programático
 * no iOS não está medido (`docs/fatos-verificados.md`).
 */
export function Campo({
  rotulo,
  valor,
  aoMudar,
  tipo = 'text',
  exemplo,
  autoFoco = false,
  multilinha = false,
}: {
  rotulo: string
  valor: string
  aoMudar: (valor: string) => void
  tipo?: 'text' | 'tel' | 'date'
  exemplo?: string
  autoFoco?: boolean
  multilinha?: boolean
}) {
  const id = useId()
  return (
    <>
      <Rotulo para={id}>{rotulo}</Rotulo>
      {multilinha ? (
        <textarea
          id={id}
          className={`${CLASSES_DE_CAMPO} py-3`}
          rows={2}
          value={valor}
          onChange={(evento) => aoMudar(evento.target.value)}
        />
      ) : (
        <input
          id={id}
          className={CLASSES_DE_CAMPO}
          type={tipo}
          inputMode={tipo === 'tel' ? 'tel' : undefined}
          autoComplete="off"
          placeholder={exemplo}
          value={valor}
          onChange={(evento) => aoMudar(evento.target.value)}
          autoFocus={autoFoco}
        />
      )}
    </>
  )
}
