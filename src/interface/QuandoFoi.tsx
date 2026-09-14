import type { Dia } from '../dominio/ficha.ts'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import type { Quando } from './datas.ts'
import { Escolha } from './Opcoes.tsx'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'

/**
 * O bloco "Quando foi" (E-10, extraído em E-11 para o recebimento usar o mesmo): Hoje / Ontem /
 * Outro dia, e o campo de data quando é outro dia. A data aparece, sempre: o "Outro dia" do
 * protótipo foi tirado por carimbar em silêncio (RN-09, D-045). `max` é hoje — para o
 * passado, nunca para o futuro. O que a escolha significa em data é `diaDoQuando` (`datas.ts`).
 */
export function QuandoFoi({ rotulo, quando, hoje, aoMudar }: { rotulo: string; quando: Quando; hoje: Dia; aoMudar: (quando: Quando) => void }) {
  return (
    <>
      <Escolha
        rotulo={rotulo}
        opcoes={[
          { valor: 'hoje', texto: PALAVRAS_DA_VENDA.hoje },
          { valor: 'ontem', texto: PALAVRAS_DA_VENDA.ontem },
          { valor: 'outro', texto: PALAVRAS_DA_VENDA.outroDia },
        ]}
        valor={quando.escolha}
        aoEscolher={(escolha) => aoMudar({ ...quando, escolha })}
      />
      {quando.escolha === 'outro' && (
        <input
          className={`${CLASSES_DE_CAMPO} mt-2`}
          type="date"
          max={hoje}
          aria-label={PALAVRAS_DA_VENDA.outroDia}
          value={quando.outroDia}
          onChange={(evento) => aoMudar({ ...quando, outroDia: evento.target.value })}
          autoFocus
        />
      )}
    </>
  )
}
