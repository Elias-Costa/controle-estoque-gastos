import { useId } from 'react'

/**
 * As classes de todo campo de texto do kit, sem largura: 52 px, borda, papel, e o foco em
 * verde. É a base dos campos compactos da venda (preço do item, valor da parcela), que têm
 * largura própria — `w-full` e `w-[6.5rem]` juntos deixariam o Tailwind decidir qual vale.
 */
export const CLASSES_DE_CAMPO_COMPACTO =
  'min-h-[52px] rounded-xl border border-borda bg-papel px-3 text-tinta focus:outline-2 focus:outline-offset-2 focus:outline-acento'

/** As classes de todo campo de texto do kit, na largura inteira. */
export const CLASSES_DE_CAMPO = `w-full ${CLASSES_DE_CAMPO_COMPACTO}`

/** O rótulo acima de um campo, em cinza, com o espaço do protótipo. */
export function Rotulo({ para, children }: { para?: string; children: string }) {
  return (
    <label htmlFor={para} className="mt-5 mb-1.5 block text-[0.95rem] text-suave">
      {children}
    </label>
  )
}

/**
 * Campo de texto, telefone, data, e-mail ou senha do kit (D-023). Uma linha por padrão;
 * `multilinha` para a observação. `autoFoco` só no primeiro campo obrigatório de uma tela — o
 * teclado do iPhone abrir sozinho ao entrar na tela é um toque a menos (RNF-02), **se abrir**:
 * foco programático no iOS não está medido (`docs/fatos-verificados.md`). `email` e `senha`
 * existem para a tela de login (E-13): teclado de e-mail sem maiúscula automática, e a senha
 * escondida.
 */

/** O `type` do `<input>` para cada tipo do kit; `senha` é o nome dela para `password`. */
const TIPO_DO_INPUT = { text: 'text', tel: 'tel', date: 'date', email: 'email', senha: 'password' } as const
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
  tipo?: keyof typeof TIPO_DO_INPUT
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
          type={TIPO_DO_INPUT[tipo]}
          inputMode={tipo === 'tel' ? 'tel' : tipo === 'email' ? 'email' : undefined}
          autoCapitalize={tipo === 'email' ? 'none' : undefined}
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
