import type { Dia } from '../dominio/ficha.ts'
import type { Despesa, ReceitaAvulsa, ReferenciaFatoCaixa } from '../dominio/gastos.ts'
import { uuidv7 } from './identidade.ts'
import type { RepositorioCaixa } from './repositorio-caixa.ts'

/** A interface informa só os dados do movimento; ids e revisões são responsabilidade do app. */
export type EntradaCaixaLocal = Omit<Despesa, 'id' | 'revisao'> | Omit<ReceitaAvulsa, 'id' | 'revisao'>

/** Identidade local → domínio/gravação conjunta; nenhuma dependência de sessão ou rede. */
export function criarOperacoesCaixa(repositorio: RepositorioCaixa) {
  return {
    registrar: (entrada: EntradaCaixaLocal) => repositorio.registrar({ ...entrada, id: uuidv7() }),
    corrigir: (alvo: ReferenciaFatoCaixa, entrada: EntradaCaixaLocal, dataCorrecao: Dia) =>
      repositorio.corrigir(alvo, { ...entrada, id: alvo.id }, dataCorrecao),
    estornar: (alvo: ReferenciaFatoCaixa, data: Dia) => repositorio.estornar(alvo, data),
  }
}
