import { PALAVRAS } from './palavras-da-ficha.ts'

/**
 * O topo de toda tela: o título e, quando há para onde voltar, o "‹" — 44 px de alvo (RNF-03),
 * puxado meio rem para a esquerda para o traço alinhar com a margem, como no protótipo.
 * `subtitulo` é o apelido da cliente na ficha: duas Marias se distinguem por ele (RF-01).
 * `acao` é um botão de texto à direita, o padrão de "Quem está devendo ›" na tela inicial
 * (D-047): zero altura, fora do caminho cronometrado — na ficha, é "Mudar dados ›" (D-050).
 */
export function Topo({
  titulo,
  subtitulo,
  aoVoltar,
  acao,
}: {
  titulo: string
  subtitulo?: string
  aoVoltar?: () => void
  acao?: { readonly texto: string; readonly aoTocar: () => void }
}) {
  return (
    <header className="mb-3 flex items-center gap-1">
      {aoVoltar !== undefined && (
        <button
          type="button"
          className="-ml-2 min-h-11 min-w-11 border-0 bg-transparent text-[2rem] leading-none text-tinta"
          onClick={aoVoltar}
          aria-label={PALAVRAS.voltar}
        >
          &lsaquo;
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="m-0 truncate text-2xl leading-tight">{titulo}</h1>
        {subtitulo !== undefined && subtitulo !== '' && <p className="m-0 truncate text-[0.95rem] text-suave">{subtitulo}</p>}
      </div>
      {acao !== undefined && (
        <button type="button" className="min-h-11 flex-none border-0 bg-transparent px-1 py-0 text-[1rem] font-semibold text-acento" onClick={acao.aoTocar}>
          {acao.texto} <span aria-hidden="true">&rsaquo;</span>
        </button>
      )}
    </header>
  )
}
