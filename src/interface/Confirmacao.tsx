import type { ReactNode } from 'react'
import { Botao } from './Botao.tsx'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'

/**
 * O invólucro da confirmação do protótipo (E-10, extraído em E-11 para o recebimento usar o
 * mesmo): o "✓", a linha do que aconteceu, o número grande que ela confere em voz alta com
 * a cliente, uma terceira linha opcional (o troco, D-016), e os dois botões de sempre —
 * "Ver a fichinha" / "Voltar para o começo". Uma tela pode pôr **uma** ação própria acima
 * deles (o "Considerar pago", D-046); ela passa a ser o botão principal e "Ver a fichinha"
 * desce para secundário — dois botões verdes empilhados não dizem qual é o de agora.
 * Um `complemento` opcional fica **sob as linhas**, no corpo (o recibo, D-047): o rodapé
 * já pode ter três botões, e quatro empilhados não dizem qual é o de agora.
 * O que as linhas dizem é de cada tela; o número vem sempre **relido da base** (RN-01).
 */
export function Confirmacao({
  primeira,
  segunda,
  terceira,
  aviso,
  complemento,
  acaoPropria,
  aoVerFicha,
  aoVoltarAoInicio,
}: {
  primeira: string
  segunda: string
  terceira?: string
  /** Uma frase de recusa ou falha, em palavras dela, quando a ação própria não conseguiu. */
  aviso?: string | null
  complemento?: ReactNode
  acaoPropria?: ReactNode
  aoVerFicha: () => void
  aoVoltarAoInicio: () => void
}) {
  return (
    <main className="tela pt-14 text-center">
      {/* O "✓" do protótipo, como caractere: `&check;` não está na tabela de entidades do JSX. */}
      <p className="m-0 text-[3.5rem] leading-none text-acento" aria-hidden="true">
        {'✓'}
      </p>
      <p className="mt-4 mb-0 text-[1.375rem]">{primeira}</p>
      <p className="mt-2 mb-0 text-[1.75rem] font-bold tabular-nums">{segunda}</p>
      {terceira !== undefined && <p className="mt-2 mb-0 text-[1.25rem] tabular-nums">{terceira}</p>}
      {aviso != null && <p className="mt-4 mb-0 font-semibold text-atraso">{aviso}</p>}
      {complemento !== undefined && <div className="mt-8">{complemento}</div>}
      <div className="rodape-acao">
        {acaoPropria}
        <Botao tipo={acaoPropria === undefined ? 'principal' : 'secundario'} aoTocar={aoVerFicha}>
          {PALAVRAS_DA_VENDA.verAFichinha}
        </Botao>
        <Botao tipo="secundario" aoTocar={aoVoltarAoInicio}>
          {PALAVRAS_DA_VENDA.voltarParaOComeco}
        </Botao>
      </div>
    </main>
  )
}
