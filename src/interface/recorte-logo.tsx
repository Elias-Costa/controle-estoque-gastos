import { useEffect, useId, useRef, useState } from 'react'
import { desenharLogoCircular, prepararLogoLoja, type EnquadramentoLogo } from '../plataforma/logo-loja.ts'
import { Botao } from './Botao.tsx'

const INICIAL: EnquadramentoLogo = { x: 0, y: 0, zoom: 1 }
const limitar = (valor: number) => Math.max(-1, Math.min(1, valor))

/** D-076: enquadramento local; cancelar nunca substitui a imagem do rascunho. */
export function RecorteLogo({ origem, aoUsar, aoCancelar }: { origem: Blob | string; aoUsar: (logo: string) => void; aoCancelar: () => void }) {
  const id = useId(), tela = useRef<HTMLCanvasElement>(null)
  const arraste = useRef<{ ponteiro: number; x: number; y: number; inicio: EnquadramentoLogo }>(undefined)
  const [imagem, setImagem] = useState<HTMLImageElement>(), [enquadramento, setEnquadramento] = useState(INICIAL)
  const [preparando, setPreparando] = useState(false), [erro, setErro] = useState<string>()
  useEffect(() => {
    const url = typeof origem === 'string' ? origem : URL.createObjectURL(origem)
    const foto = new Image(); let ativo = true
    foto.src = url
    void foto.decode().then(() => { if (ativo) setImagem(foto) }, () => {
      if (ativo) setErro('Não consegui abrir esta imagem. Escolha outra logo.')
    })
    return () => { ativo = false; if (typeof origem !== 'string') URL.revokeObjectURL(url) }
  }, [origem])
  useEffect(() => {
    const contexto = tela.current?.getContext('2d')
    if (!imagem || !contexto) return
    try { desenharLogoCircular(contexto, imagem, 512, enquadramento) }
    catch { setErro('Não consegui mostrar o recorte. Escolha outra imagem.') }
  }, [imagem, enquadramento])
  async function usar() {
    if (!imagem || preparando) return
    setPreparando(true); setErro(undefined)
    try { aoUsar(await prepararLogoLoja(imagem, enquadramento)) }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não consegui preparar esta logo. Tente outra imagem.') }
    finally { setPreparando(false) }
  }
  return <section aria-label="Ajustar logo" className="my-4 min-w-0">
    <h3 className="mt-0 text-lg font-semibold">Ajustar logo</h3>
    <p id={`${id}-ajuda`}>Arraste para posicionar. No teclado, use as setas. Ajuste o tamanho abaixo.</p>
    <div role="group" aria-label="Posição da logo" aria-describedby={`${id}-ajuda`} tabIndex={0}
      className="mx-auto aspect-square w-64 max-w-full cursor-move overflow-hidden rounded-full border-2 border-suave bg-fundo focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-acento"
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        if (!imagem || preparando || !e.isPrimary || e.button !== 0) return
        e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId)
        arraste.current = { ponteiro: e.pointerId, x: e.clientX, y: e.clientY, inicio: enquadramento }
      }}
      onPointerMove={(e) => {
        const inicio = arraste.current
        if (!inicio || inicio.ponteiro !== e.pointerId || preparando) return
        const lado = e.currentTarget.getBoundingClientRect().width
        setEnquadramento({ ...inicio.inicio, x: limitar(inicio.inicio.x + (e.clientX - inicio.x) / lado), y: limitar(inicio.inicio.y + (e.clientY - inicio.y) / lado) })
      }}
      onPointerUp={(e) => { if (arraste.current?.ponteiro === e.pointerId) arraste.current = undefined }}
      onPointerCancel={() => { arraste.current = undefined }} onLostPointerCapture={() => { arraste.current = undefined }}
      onKeyDown={(e) => {
        if (!imagem || preparando || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
        e.preventDefault()
        const passo = e.shiftKey ? 0.1 : 0.01
        setEnquadramento((atual) => ({ ...atual, x: limitar(atual.x + (e.key === 'ArrowRight' ? passo : e.key === 'ArrowLeft' ? -passo : 0)),
          y: limitar(atual.y + (e.key === 'ArrowDown' ? passo : e.key === 'ArrowUp' ? -passo : 0)) }))
      }}>
      <canvas ref={tela} width={512} height={512} role="img" aria-label="Prévia do recorte circular" className="block h-full w-full" />
    </div>
    {!imagem && !erro && <p role="status">Abrindo imagem…</p>}
    <label htmlFor={`${id}-zoom`} className="mt-4 block">Tamanho da logo: {Math.round(enquadramento.zoom * 100)}%</label>
    <input id={`${id}-zoom`} aria-label="Tamanho da logo" type="range" min={50} max={400} step={1}
      value={Math.round(enquadramento.zoom * 100)} disabled={!imagem || preparando} className="min-h-11 w-full accent-acento"
      onChange={(e) => { const zoom = Number(e.currentTarget.value) / 100; setEnquadramento((atual) => ({ ...atual, zoom })) }} />
    <p>O PDF usará este recorte.</p>
    {typeof origem === 'string' && <p>Para recuperar partes cortadas antes, escolha a imagem original.</p>}
    {erro && <p role="alert">{erro}</p>}
    <div className="flex flex-wrap gap-3">
      <Botao tipo="principal" desabilitado={!imagem || preparando} aoTocar={() => void usar()}>Usar logo</Botao>
      <Botao tipo="secundario" desabilitado={preparando} aoTocar={() => setEnquadramento(INICIAL)}>Centralizar imagem</Botao>
      <Botao tipo="secundario" desabilitado={preparando} aoTocar={aoCancelar}>Cancelar recorte</Botao>
    </div>
  </section>
}
