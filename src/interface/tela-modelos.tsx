import { useRef, useState } from 'react'
import { repositorioModelos } from '../dados/instancia.ts'
import { MODELOS_ORIGINAIS, SITUACOES_MENSAGEM, modeloValido, modelosValidos, trechosDaMensagem,
  type ModelosWhatsApp, type PreferenciaModelos, type SituacaoMensagem, type TrechoMensagem } from '../dados/modelos-whatsapp.ts'
import { Botao } from './Botao.tsx'
import { Topo } from './Topo.tsx'
import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { renderizarModelo } from './modelos-da-mensagem.ts'
import { useLeitura } from './useLeitura.ts'

const SITUACOES: Record<SituacaoMensagem, string> = { 'cobranca-vencida': 'Cobrança em atraso', 'cobranca-a-vencer': 'Cobrança a vencer',
  'recibo-com-saldo': 'Recibo com saldo', 'recibo-quitado': 'Recibo quitado' }
const TRECHOS: Record<TrechoMensagem, string> = { nome: 'Nome', valor: 'Valor', vencimento: 'Vencimento', saldo: 'Saldo da fichinha' }

/** Editor offline com quatro padrões; nomes do negócio inserem os trechos restritos (RI-07). */
export function TelaModelos({ aoVoltar }: { aoVoltar: () => void }) {
  const leitura = useLeitura(() => repositorioModelos.ler(), 'modelos')
  if (leitura.estado !== 'lido') return <main className="tela"><Topo titulo="Mensagens do WhatsApp" aoVoltar={aoVoltar} />
    {leitura.estado === 'falhou' && <p role="alert">Não deu para abrir os textos. Tente de novo.</p>}</main>
  // Releituras remotas não remontam o editor nem substituem o rascunho que está sendo digitado.
  return <EditorModelos inicial={leitura.valor} aoVoltar={aoVoltar} />
}

function EditorModelos({ inicial, aoVoltar }: { inicial: PreferenciaModelos | undefined; aoVoltar: () => void }) {
  const [base, setBase] = useState(inicial)
  const [modelos, setModelos] = useState<ModelosWhatsApp>(inicial?.modelos ?? MODELOS_ORIGINAIS)
  const [situacao, setSituacao] = useState<SituacaoMensagem>('cobranca-vencida')
  const [conflito, setConflito] = useState<{ atual: PreferenciaModelos | undefined } | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const campo = useRef<HTMLTextAreaElement>(null)
  const dadosExemplo = { nome: 'Maria Silva', valor: 5000n, saldo: situacao === 'recibo-quitado' ? 0n : 12500n, vencimento: '2026-10-30' }
  const previa = renderizarModelo(modelos[situacao], situacao, dadosExemplo)
  function mudar(texto: string) { setModelos((m) => ({ ...m, [situacao]: texto })); setAviso(null) }
  function inserir(trecho: TrechoMensagem) {
    const inicio = campo.current?.selectionStart ?? modelos[situacao].length
    const fim = campo.current?.selectionEnd ?? inicio
    const inserido = `{${trecho}}`
    mudar(modelos[situacao].slice(0, inicio) + inserido + modelos[situacao].slice(fim))
    requestAnimationFrame(() => { campo.current?.focus(); campo.current?.setSelectionRange(inicio + inserido.length, inicio + inserido.length) })
  }
  async function salvar(esperada: PreferenciaModelos | undefined) {
    setSalvando(true); setAviso(null)
    try {
      const resultado = await repositorioModelos.salvar(modelos, esperada)
      if (!resultado.ok) { setConflito({ atual: resultado.atual }); return }
      setBase(resultado.preferencia); setConflito(null); setAviso('Textos guardados neste aparelho.')
    } catch { setAviso('Não deu para guardar os textos. O que você escreveu continua aqui. Tente de novo.') }
    finally { setSalvando(false) }
  }
  const atual = conflito ? (conflito.atual?.modelos ?? MODELOS_ORIGINAIS)[situacao] : null
  return <main className="tela"><Topo titulo="Mensagens do WhatsApp" aoVoltar={aoVoltar} />
    <p>Escolha a mensagem e mude o texto. Você confere antes de abrir o WhatsApp e envia por lá.</p>
    <label className="block font-semibold" htmlFor="situacao-mensagem">Mensagem</label>
    <select id="situacao-mensagem" className="mt-2 mb-4 min-h-11 w-full rounded-xl border border-contorno bg-papel p-3 text-tinta"
      value={situacao} onChange={(e) => { const s = SITUACOES_MENSAGEM.find((s) => s === e.target.value); if (s) setSituacao(s) }}>
      {SITUACOES_MENSAGEM.map((s) => <option key={s} value={s}>{SITUACOES[s]}</option>)}
    </select>
    <label className="block font-semibold" htmlFor="texto-mensagem">Texto da mensagem</label>
    <textarea id="texto-mensagem" ref={campo} rows={7} value={modelos[situacao]} onChange={(e) => mudar(e.target.value)}
      className="mt-2 w-full rounded-xl border border-contorno bg-papel p-3 text-tinta" aria-invalid={!modeloValido(modelos[situacao], situacao)} />
    <p className="mb-1">Inserir no texto:</p>
    <div className="flex flex-wrap gap-2">{trechosDaMensagem(situacao).map((t) => <button key={t} type="button"
      className="min-h-11 min-w-11 rounded-xl border border-contorno bg-papel px-3 text-tinta" onClick={() => inserir(t)}>
      {t === 'valor' ? situacao.startsWith('cobranca') ? 'Valor da parcela' : 'Valor recebido' : TRECHOS[t]}</button>)}</div>
    <button type="button" className="mt-2 min-h-11 border-0 bg-transparent px-1 text-acento underline" onClick={() => mudar(MODELOS_ORIGINAIS[situacao])}>Voltar ao texto original</button>
    <h2 className="text-lg">Exemplo da mensagem</h2><p>Exemplo com Maria, sem enviar.</p>
    {previa.ok ? <p data-modelo-previa className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{previa.texto}</p>
      : <p role="alert" className="text-atraso">Escreva um texto e use os botões para inserir os trechos. Confira se algum trecho foi apagado pela metade.</p>}
    {!modelosValidos(modelos) && <p className="text-atraso">Confira os textos antes de guardar: {SITUACOES_MENSAGEM.filter((s) => !modeloValido(modelos[s], s)).map((s) => SITUACOES[s]).join(', ')}.</p>}
    {conflito && <section role="alert" className="my-4 rounded-xl border border-contorno p-3">
      <p className="font-semibold">Os textos mudaram desde que você abriu. O que você escreveu continua aqui.</p>
      <p>Texto guardado agora para {SITUACOES[situacao]}:</p><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{atual}</p>
      <Botao tipo="secundario" aoTocar={() => { setBase(conflito.atual); setModelos(conflito.atual?.modelos ?? MODELOS_ORIGINAIS); setConflito(null); setAviso(null) }}>Carregar os textos guardados</Botao>
      <Botao tipo="secundario" className="mt-2" desabilitado={salvando || !modelosValidos(modelos)} aoTocar={() => void salvar(conflito.atual)}>Guardar os meus quatro textos</Botao>
    </section>}
    {aviso && <p role="status">{aviso}</p>}
    <RodapeDeAcoes><Botao tipo="principal" aoTocar={() => void salvar(base)} desabilitado={salvando || !modelosValidos(modelos) || conflito !== null}>Guardar os textos</Botao></RodapeDeAcoes>
  </main>
}
