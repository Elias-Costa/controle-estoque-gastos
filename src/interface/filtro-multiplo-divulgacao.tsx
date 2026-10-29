import { useEffect, useRef } from 'react'
import { CLASSES_DE_CAMPO } from './Campo.tsx'

/** D-074: lista recolhível com Todas/nenhuma explícitas; escolhas ficam só na tela. */
export function FiltroMultiploDivulgacao({ titulo, todas, opcoes, selecionadas, ocupado, aoMudar }: {
  titulo: string; todas: string; opcoes: readonly { valor: string; rotulo: string }[];
  selecionadas: readonly string[] | null; ocupado: boolean; aoMudar: (valores: readonly string[] | null) => void;
}) {
  const caixaTodas = useRef<HTMLInputElement>(null)
  const quantidade = opcoes.filter((o) => selecionadas?.includes(o.valor)).length
  const todasMarcadas = selecionadas === null || opcoes.length > 0 && quantidade === opcoes.length
  const parcial = !todasMarcadas && quantidade > 0
  useEffect(() => { if (caixaTodas.current) caixaTodas.current.indeterminate = parcial }, [parcial])
  const resumo = selecionadas === null ? todas : selecionadas.length ? `${selecionadas.length} selecionada${selecionadas.length === 1 ? '' : 's'}` : 'Nenhuma selecionada'
  function mudarOpcao(valor: string, marcar: boolean) {
    const atuais = selecionadas ?? opcoes.map((o) => o.valor)
    aoMudar(marcar ? [...new Set([...atuais, valor])].sort() : atuais.filter((v) => v !== valor))
  }
  return <fieldset disabled={ocupado} className="mt-3 min-w-0 border-0 p-0">
    <legend>{titulo}</legend>
    <details>
      <summary className={`${CLASSES_DE_CAMPO} cursor-pointer py-3`}>{resumo}</summary>
      <div className="mt-2 rounded-xl border border-borda bg-papel p-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 py-2">
          <input ref={caixaTodas} type="checkbox" className="h-6 w-6 shrink-0 accent-acento" checked={todasMarcadas}
            onChange={(e) => aoMudar(e.currentTarget.checked ? null : [])} /><span>{todas}</span>
        </label>
        {opcoes.map((o) => <label key={o.valor} className="flex min-h-11 cursor-pointer items-center gap-3 py-2">
          <input type="checkbox" className="h-6 w-6 shrink-0 accent-acento" checked={selecionadas === null || selecionadas.includes(o.valor)}
            onChange={(e) => mudarOpcao(o.valor, e.currentTarget.checked)} /><span className="min-w-0 break-words">{o.rotulo}</span>
        </label>)}
        {selecionadas?.length === 0 && <p role="status">Marque pelo menos uma opção para incluir produtos.</p>}
      </div>
    </details>
  </fieldset>
}
