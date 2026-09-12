import { PALAVRAS } from './palavras-da-ficha.ts'

/**
 * O topo de toda tela: o título e, quando há para onde voltar, o "‹" — 44 px de alvo (RNF-03),
 * puxado meio rem para a esquerda para o traço alinhar com a margem, como no protótipo.
 * `subtitulo` é o apelido da cliente na ficha: duas Marias se distinguem por ele (RF-01).
 */
export function Topo({ titulo, subtitulo, aoVoltar }: { titulo: string; subtitulo?: string; aoVoltar?: () => void }) {
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
      <div className="min-w-0">
        <h1 className="m-0 truncate text-2xl leading-tight">{titulo}</h1>
        {subtitulo !== undefined && subtitulo !== '' && <p className="m-0 truncate text-[0.95rem] text-suave">{subtitulo}</p>}
      </div>
    </header>
  )
}
