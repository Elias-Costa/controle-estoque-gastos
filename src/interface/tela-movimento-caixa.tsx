import { useRef, useState } from 'react'
import { operacoesCaixa, repositorioCaixa } from '../dados/instancia.ts'
import type { EntradaCaixaLocal } from '../dados/operacoes-caixa.ts'
import type { Despesa, ReceitaAvulsa, ReferenciaFatoCaixa } from '../dominio/gastos.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { hoje } from './datas.ts'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { Escolha } from './Opcoes.tsx'
import { fraseDaGuardaDoCaixa, PALAVRAS_DO_CAIXA as P } from './palavras-do-caixa.ts'
import { conferirCaixa, rascunhoDoCaixa, type RascunhoDoCaixa } from './rascunho-do-caixa.ts'
import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** RF-16/17/25: data/valor reais e classificação explícita; confirmar só grava no aparelho. */
export function TelaMovimentoCaixa({ tipo, alvo, aoVoltar, aoSalvar }: {
  tipo: EntradaCaixaLocal['tipo']; alvo?: ReferenciaFatoCaixa
  aoVoltar: () => void; aoSalvar: (mes: string) => void
}) {
  const leitura = useLeitura(() => repositorioCaixa.lerEstado(), alvo?.id ?? 'novo')
  const fato = leitura.estado === 'lido' && alvo ? leitura.valor.fatos.find((f) => f.id === alvo.id && f.revisao === alvo.revisao) : undefined
  const original = fato?.tipo === 'despesa' || fato?.tipo === 'receita-avulsa' ? fato : undefined
  if (leitura.estado !== 'lido' || (alvo && !original)) return <main className="tela">
    <Topo titulo={alvo ? P.correcao : tipo === 'despesa' ? P.despesa : P.receita} aoVoltar={aoVoltar} />
    <p role={leitura.estado === 'falhou' ? 'alert' : 'status'}>{leitura.estado === 'lendo' ? P.lendo : alvo && leitura.estado === 'lido' ? P.mudou : P.falhou}</p>
  </main>
  return <FormularioMovimento tipo={tipo} original={original} aoVoltar={aoVoltar} aoSalvar={aoSalvar} />
}

function FormularioMovimento({ tipo, original, aoVoltar, aoSalvar }: {
  tipo: EntradaCaixaLocal['tipo']; original?: Despesa | ReceitaAvulsa
  aoVoltar: () => void; aoSalvar: (mes: string) => void
}) {
  // A revisão da abertura não muda com um ciclo remoto; o repositório a confere ao gravar.
  const [alvo] = useState(original)
  const [rascunho, setRascunho] = useState(() => rascunhoDoCaixa(alvo, hoje()))
  const [gravando, setGravando] = useState(false), [erro, setErro] = useState<string | null>(null)
  const trava = useRef(false), conferencia = conferirCaixa(rascunho, tipo, hoje())
  function mudar(mudanca: Partial<RascunhoDoCaixa>): void { setRascunho((anterior) => ({ ...anterior, ...mudanca })); setErro(null) }
  async function salvar(): Promise<void> {
    if (trava.current || !conferencia.ok) return
    trava.current = true; setGravando(true); setErro(null)
    try {
      const resultado = alvo ? await operacoesCaixa.corrigir(alvo, conferencia.valor, hoje()) : await operacoesCaixa.registrar(conferencia.valor)
      if (!resultado.ok) { setErro(fraseDaGuardaDoCaixa(resultado.motivo)); return }
      aoSalvar(conferencia.valor.data.slice(0, 7))
    } catch { setErro(P.falhaAoGravar) }
    finally { trava.current = false; setGravando(false) }
  }
  return <main className="tela">
    <Topo titulo={alvo ? P.correcao : tipo === 'despesa' ? P.despesa : P.receita} aoVoltar={() => { if (!trava.current) aoVoltar() }} />
    <IndicadorDeEnvio />
    {alvo && <p>{P.corrigirExplicacao}</p>}
    {tipo === 'receita-avulsa' && <p>{P.receitaExplicacao}</p>}
    <fieldset disabled={gravando} className="m-0 min-w-0 border-0 p-0">
      <CampoDeDinheiro rotulo={P.valor} texto={rascunho.valorTexto} aoMudar={(valorTexto) => mudar({ valorTexto })} selecionarAoFocar />
      <Campo rotulo={P.data} tipo="date" valor={rascunho.data} aoMudar={(data) => mudar({ data })} />
      <Campo rotulo={P.categoria} valor={rascunho.categoria} aoMudar={(categoria) => mudar({ categoria })} />
      {tipo === 'despesa' && rascunho.mercadoria ? <p className="mt-5">{P.classificacao}: <strong>{P.negocio}</strong></p>
        : <Escolha rotulo={P.classificacao} valor={rascunho.classificacao} aoEscolher={(classificacao) => mudar({ classificacao })}
          opcoes={[{ valor: 'negocio', texto: P.negocio }, { valor: 'pessoal', texto: P.pessoal }]} />}
      {tipo === 'despesa' && <>
        {/* D-065/RI-08: mercadoria já determina negócio; não pedir que ela resolva a guarda. */}
        <Escolha rotulo={P.mercadoria} valor={rascunho.mercadoria ? 'sim' : 'nao'} aoEscolher={(valor) => mudar({ mercadoria: valor === 'sim', ...(valor === 'sim' ? { classificacao: 'negocio' } : {}) })}
          opcoes={[{ valor: 'nao', texto: P.nao }, { valor: 'sim', texto: P.sim }]} />
        {rascunho.mercadoria && <p>{P.mercadoriaExplicacao}</p>}
      </>}
    </fieldset>
    {!conferencia.ok && <p role="status" className="font-semibold text-atraso">{fraseDaGuardaDoCaixa(conferencia.motivo)}</p>}
    {erro && <p role="alert" className="font-semibold text-atraso">{erro}</p>}
    <RodapeDeAcoes><Botao tipo="principal" aoTocar={() => void salvar()} desabilitado={gravando || !conferencia.ok}>{gravando ? P.salvando : P.salvar}</Botao></RodapeDeAcoes>
  </main>
}
