import { PALAVRAS } from './palavras-da-ficha.ts'

/** Mantém a primeira pendência junto da ação; só falha de gravação é alerta (UX-02/RNF-03). */
export function AvisosDoFormulario({ frases, erro }: { frases: readonly string[]; erro: string | null }) {
  const primeira = frases[0]
  return <>
    {/* O aviso muda só ao entrar/sair do estado pendente, sem ler somas a cada tecla. */}
    <p role="status" className="sr-only">{primeira ? PALAVRAS.conferirPreenchimento : ''}</p>
    {primeira && <p className="m-0 rounded-xl border border-contorno bg-papel p-3 text-[1rem] font-semibold text-tinta [overflow-wrap:anywhere]">{primeira}</p>}
    {erro !== null && <p role="alert" className="m-0 rounded-xl border border-contorno bg-papel p-3 text-[1rem] font-semibold text-atraso [overflow-wrap:anywhere]">{erro}</p>}
  </>
}
