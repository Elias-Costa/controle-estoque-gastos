import { useId } from 'react'

/** A pílula marcada: borda verde dupla e negrito, como `.opcao:has(input:checked)` e `.vez.ativa` do protótipo. */
const MARCADA = 'border-acento shadow-[inset_0_0_0_1px_var(--acento)]'

/**
 * Os rádios em pílula do protótipo (`.opcao`): "Fiado / À vista", "Pix / Dinheiro", "Hoje /
 * Ontem / Outro dia". 48 px de alvo (RNF-03); a marcada ganha a borda verde e o negrito. É um
 * `fieldset` com `legend` para o rótulo ficar onde os outros rótulos ficam e o leitor de tela
 * saber que as opções são de uma pergunta só. Cada tela decide o padrão marcado — e o padrão
 * é reinicializado a cada entrada, porque a tela é montada de novo (lição de E-02).
 */
export function Escolha<T extends string>({
  rotulo,
  opcoes,
  valor,
  aoEscolher,
}: {
  rotulo: string
  opcoes: readonly { readonly valor: T; readonly texto: string }[]
  valor: T
  aoEscolher: (valor: T) => void
}) {
  const nome = useId()
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mt-5 mb-1.5 block w-full p-0 text-[0.95rem] text-suave">{rotulo}</legend>
      <div className="flex flex-wrap gap-2">
        {opcoes.map((opcao) => {
          const marcada = opcao.valor === valor
          return (
            <label
              key={opcao.valor}
              className={`flex min-h-12 items-center gap-2 rounded-full border bg-papel px-4 ${marcada ? `${MARCADA} font-semibold` : 'border-borda'}`}
            >
              <input
                type="radio"
                name={nome}
                value={opcao.valor}
                checked={marcada}
                onChange={() => aoEscolher(opcao.valor)}
                className="m-0 h-5 min-h-0 w-5 accent-acento"
              />
              <span>{opcao.texto}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** O máximo de "vezes" que a venda, o cadastro e o saldo anterior oferecem (D-050, item 3): ela pediu 6×. */
export const MAXIMO_DE_VEZES = 6

/**
 * "Em quantas vezes": 1× a N× lado a lado, como `.vezes` do protótipo (1×–4× validados na
 * sessão de 2026-09-08; **até 6× desde a visita de E-15**, D-050 item 3 — seis pílulas de
 * ~50 px em 375 px). `maximo` só passa de `MAXIMO_DE_VEZES` na correção de uma venda que já
 * tinha mais parcelas — a tela nunca oferece menos do que a venda tem.
 */
export function Vezes({ rotulo, maximo, valor, aoEscolher }: { rotulo: string; maximo: number; valor: number; aoEscolher: (vezes: number) => void }) {
  const vezes = Array.from({ length: maximo }, (_, posicao) => posicao + 1)
  return (
    <div>
      <p className="mt-5 mb-1.5 text-[0.95rem] text-suave">{rotulo}</p>
      <div className="flex gap-2">
        {vezes.map((quantidade) => {
          const ativa = quantidade === valor
          return (
            <button
              key={quantidade}
              type="button"
              aria-pressed={ativa}
              className={`min-h-[52px] flex-1 rounded-xl border bg-papel text-tinta ${ativa ? `${MARCADA} font-bold` : 'border-borda'}`}
              onClick={() => aoEscolher(quantidade)}
            >
              {quantidade}&times;
            </button>
          )
        })}
      </div>
    </div>
  )
}
