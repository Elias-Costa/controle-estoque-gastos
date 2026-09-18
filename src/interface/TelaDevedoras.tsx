import { useState } from 'react'
import type { Id } from '../dominio/ficha.ts'
import { lerResumos } from './ler-resumos.ts'
import { devedoras, type FiltroDeDevedoras, type OrdemDeDevedoras } from './leitura-da-ficha.ts'
import { Lista } from './ListaDeFichas.tsx'
import { Escolha } from './Opcoes.tsx'
import { FILTROS, fraseDaListaVazia, ORDENS, PALAVRAS_DA_COBRANCA } from './palavras-da-cobranca.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/**
 * "Quem está devendo" (RF-10, E-12): a dor nº 3 do briefing — "descobrir quem está atrasado
 * exige folhear ficha por ficha, então não é feito". Tela própria (D-047 item 2), aberta do
 * cabeçalho da inicial; abre em "Em atraso" e "Maior atraso" (item 3), então a resposta já
 * está na tela sem toque, e a lista vazia diz "Ninguém em atraso" — boa notícia. (As palavras
 * eram "Mais atrasada" e "Ninguém atrasada" até a visita de E-15, D-050 item 2.)
 *
 * É a mesma leitura e a mesma linha da lista de fichinhas: nome, quanto deve, "em atraso há N
 * dias" — sem as fichinhas desativadas, mesmo devendo (D-050, item 6). A linha abre a ficha —
 * é lá que se cobra (RF-09). Filtro e ordem são estado da tela, e voltam ao padrão a cada
 * entrada, como toda tela (lição de E-02).
 */
export function TelaDevedoras({ aoVoltar, aoAbrirFicha }: { aoVoltar: () => void; aoAbrirFicha: (clienteId: Id) => void }) {
  const [filtro, setFiltro] = useState<FiltroDeDevedoras>('em-atraso')
  const [ordem, setOrdem] = useState<OrdemDeDevedoras>('atraso')
  const leitura = useLeitura(lerResumos, 'devedoras')

  return (
    <main className="tela">
      <Topo titulo={PALAVRAS_DA_COBRANCA.quemEstaDevendo} aoVoltar={aoVoltar} />
      <Escolha rotulo={PALAVRAS_DA_COBRANCA.mostrar} opcoes={FILTROS} valor={filtro} aoEscolher={setFiltro} />
      <Escolha rotulo={PALAVRAS_DA_COBRANCA.ordem} opcoes={ORDENS} valor={ordem} aoEscolher={setOrdem} />
      <div className="mt-3">
        {leitura.estado === 'lido' && <Lista resumos={devedoras(leitura.valor, filtro, ordem)} vazia={fraseDaListaVazia(filtro)} aoAbrir={aoAbrirFicha} />}
        {leitura.estado === 'falhou' && <p className="mt-3 text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
      </div>
    </main>
  )
}
