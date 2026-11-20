import { useId, useRef, useState } from 'react'
import { repositorioPrazoEncalhe } from '../dados/instancia.ts'
import type { PreferenciaEncalhe } from '../dados/prazo-encalhe.ts'
import { PRAZO_DE_ENCALHE_PADRAO } from '../dominio/indicadores.ts'
import { quantidadeValida } from '../dominio/regras-estoque.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO, Rotulo } from './Campo.tsx'
import { PALAVRAS_DO_RESUMO as P } from './palavras-do-resumo.ts'

type Edicao = { texto: string; base: PreferenciaEncalhe | undefined; conflito?: boolean }

/** RF-22/D-089. Cada salvamento confere a edição que a pessoa conhecia ao digitar. */
export function EditorPrazoEncalhe({ preferencia }: { preferencia: PreferenciaEncalhe | undefined }) {
  const id = useId()
  const [edicao, setEdicao] = useState<Edicao>()
  const [estado, setEstado] = useState<'pronto' | 'salvando' | 'salvo' | 'falhou'>('pronto')
  const emCurso = useRef(false)
  const prazoAtual = preferencia?.dias ?? PRAZO_DE_ENCALHE_PADRAO
  const texto = edicao?.texto ?? String(prazoAtual)
  const dias = Number(texto)
  const valido = /^\d+$/.test(texto) && quantidadeValida(dias)

  async function salvar() {
    if (!edicao || !valido || emCurso.current) return
    emCurso.current = true
    setEstado('salvando')
    try {
      const resultado = await repositorioPrazoEncalhe.salvar(dias, edicao.base)
      if (resultado.ok) {
        setEdicao(undefined)
        setEstado('salvo')
      } else {
        setEdicao({ ...edicao, base: resultado.atual, conflito: true })
        setEstado('pronto')
      }
    } catch {
      setEstado('falhou')
    } finally {
      emCurso.current = false
    }
  }

  return <fieldset disabled={estado === 'salvando'} className="m-0 mt-3 min-w-0 border-0 p-0">
    <Rotulo para={id}>{P.prazo}</Rotulo>
    <input id={id} className={CLASSES_DE_CAMPO} inputMode="numeric" value={texto}
      aria-invalid={!valido || undefined} aria-describedby={!valido ? `${id}-ajuda` : undefined}
      onChange={(e) => {
        setEdicao({ ...edicao, texto: e.target.value, base: edicao ? edicao.base : preferencia })
        setEstado('pronto')
      }} />
    {!valido && <p id={`${id}-ajuda`} className="mt-1 text-atraso">{P.prazoInvalido}</p>}
    {edicao?.conflito && <p role="alert" className="mt-2 text-atraso">
      O prazo mudou para {edicao.base?.dias ?? PRAZO_DE_ENCALHE_PADRAO} dias. Confira antes de salvar o que você digitou.
    </p>}
    {estado === 'falhou' && <p role="alert" className="mt-2 text-atraso">{P.falhaPrazo}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Botao tipo="principal" className="flex-1 basis-36" desabilitado={!edicao || !valido || dias === prazoAtual} aoTocar={() => void salvar()}>
        {estado === 'salvando' ? 'Salvando…' : P.guardarPrazo}
      </Botao>
      {edicao && <Botao tipo="secundario" className="flex-1 basis-36" aoTocar={() => { setEdicao(undefined); setEstado('pronto') }}>
        Cancelar
      </Botao>}
    </div>
    <p role="status" className="mt-1 text-suave">{estado === 'salvo' ? P.prazoSalvo : ''}</p>
  </fieldset>
}
