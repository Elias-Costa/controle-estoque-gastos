import { useId, useRef, useState } from 'react'
import { operacoesCaixa, repositorioCaixa } from '../dados/instancia.ts'
import type { EstadoLocalCaixa } from '../dados/repositorio-caixa.ts'
import type { VersaoCaixa } from '../dados/tipos-caixa.ts'
import { projetarCaixa } from '../dominio/caixa.ts'
import { emReais } from '../dominio/dinheiro.ts'
import type { Despesa, FatoCaixa, ReceitaAvulsa } from '../dominio/gastos.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO, Rotulo } from './Campo.tsx'
import { hoje } from './datas.ts'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { linhasDoCaixa, type CorteCaixa } from './leitura-do-caixa.ts'
import { Escolha } from './Opcoes.tsx'
import { fraseDaGuardaDoCaixa, PALAVRAS_DO_CAIXA as P } from './palavras-do-caixa.ts'
import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

function dataCompleta(data: string): string { return data.split('-').reverse().join('/') }
function natureza(f: Despesa | ReceitaAvulsa): string { return f.tipo === 'receita-avulsa' ? P.entrada : f.mercadoria ? P.compra : P.gasto }

/** RF-18: consulta local, projeção do domínio e evidência D-070 sem gerar nova intenção. */
export function TelaCaixa({ mes, corte, aoMes, aoCorte, aoVoltar, aoAnotar, aoCorrigir }: {
  mes: string; corte: CorteCaixa; aoMes: (mes: string) => void; aoCorte: (corte: CorteCaixa) => void
  aoVoltar: () => void; aoAnotar: (tipo: 'despesa' | 'receita-avulsa') => void; aoCorrigir: (fato: Despesa | ReceitaAvulsa) => void
}) {
  const [releituras, reler] = useState(0), mesId = useId()
  const leitura = useLeitura(() => repositorioCaixa.lerEstado(), String(releituras))
  const estado = leitura.estado === 'lido' ? leitura.valor : undefined
  const projecao = estado ? projetarCaixa(estado.fatos, estado.lancamentos, mes) : undefined
  const linhas = estado ? linhasDoCaixa(estado, mes, corte) : []
  const totais = projecao?.ok ? projecao.valor[corte] : undefined
  const problemas = estado?.versoes.filter((v) => v.problema || v.foraDaProjecao) ?? []
  const fatosHistoricos = estado ? [...estado.fatos, ...estado.versoes.flatMap((v) => v.grupo.fatos)] : []
  return <main className="tela">
    <Topo titulo={P.titulo} aoVoltar={aoVoltar} /><IndicadorDeEnvio />
    <Rotulo para={mesId}>{P.mes}</Rotulo>
    <input id={mesId} type="month" className={CLASSES_DE_CAMPO} value={mes} onChange={(e) => aoMes(e.target.value)} />
    <Escolha rotulo={P.mostrar} valor={corte} aoEscolher={aoCorte} opcoes={[
      { valor: 'tudo', texto: P.tudo }, { valor: 'negocio', texto: P.negocio }, { valor: 'pessoal', texto: P.pessoal },
    ]} />
    <p className="text-suave">{P.alcance}</p>
    {leitura.estado === 'lendo' && <p role="status">{P.lendo}</p>}
    {(leitura.estado === 'falhou' || (projecao && !projecao.ok)) && <p role="alert">{mes ? P.falhou : P.escolherMes}</p>}
    {totais && estado && <>
      <dl className="my-5 rounded-2xl border border-borda bg-papel p-4" aria-live="polite" aria-atomic="true">
        {([{ chave: 'entrou', titulo: P.entrou }, { chave: 'saiu', titulo: P.saiu }, { chave: 'diferenca', titulo: P.diferenca }] as const).map(({ chave, titulo }) =>
          <div key={chave} className="mb-2 flex flex-wrap justify-between gap-x-4 gap-y-1 last:mb-0">
            <dt>{titulo}</dt><dd data-caixa-total={chave} className={`m-0 min-w-0 max-w-full text-2xl font-semibold tabular-nums [overflow-wrap:anywhere] ${chave === 'diferenca' && totais.diferenca < 0n ? 'text-atraso' : ''}`}>{emReais(totais[chave])}</dd>
          </div>)}
      </dl>
      <h2 className="text-xl">{P.movimentos}</h2>
      {linhas.length === 0 && <p role="status">{P.vazio}</p>}
      <ul className="m-0 list-none p-0">
        {linhas.map((linha) => <li key={linha.id} data-caixa-id={linha.id} className="border-b border-borda py-4 [overflow-wrap:anywhere]">
          <p className="m-0 font-semibold">{linha.titulo}</p>
          <p className="my-1 text-suave">{linha.detalhe} · {dataCompleta(linha.data)} · {linha.classificacao === 'negocio' ? P.negocio : P.pessoal}</p>
          <p className="my-1 text-xl font-semibold tabular-nums">{linha.direcao === 'saida' ? '−' : '+'} {emReais(linha.valor)}</p>
          {linha.fato && !problemas.some((v) => v.grupo.fatos.some((f) => f.id === linha.id)) && <AcoesDoFato key={`${linha.id}/${linha.fato.revisao}`} fato={linha.fato} aoCorrigir={() => { if (linha.fato) aoCorrigir(linha.fato) }} aoSalvar={() => reler((n) => n + 1)} />}
        </li>)}
      </ul>
      <HistoricoCaixa estado={estado} mes={mes} corte={corte} />
    </>}
    {problemas.length > 0 && <section aria-label={P.conferir} className="my-5 rounded-xl border border-atraso p-3 [overflow-wrap:anywhere]">
      <h2 className="text-xl">{P.conferir}</h2>
      {problemas.map((v) => <div key={v.id} data-caixa-conferencia={v.id} className="border-b border-borda py-3 last:border-0">
        <p className="font-semibold">{v.problema ? P.recusada : v.restaurada && v.foraDaProjecao?.causaId === v.id ? P.copiada : P.dependente}</p>
        {v.problema && v.foraDaProjecao && v.foraDaProjecao.causaId !== v.id && <p>{P.dependente}</p>}
        {v.grupo.fatos.map((f) => <ResumoFato key={f.id} fato={f} fatos={fatosHistoricos} />)}
        <p>{v.foraDaProjecao ? P.fora : P.provisoria}</p>
      </div>)}
    </section>}
    <RodapeDeAcoes>
      <Botao tipo="principal" aoTocar={() => aoAnotar('despesa')}>{P.despesa}</Botao>
      <Botao tipo="secundario" aoTocar={() => aoAnotar('receita-avulsa')}>{P.receita}</Botao>
    </RodapeDeAcoes>
  </main>
}

function AcoesDoFato({ fato, aoCorrigir, aoSalvar }: { fato: Despesa | ReceitaAvulsa; aoCorrigir: () => void; aoSalvar: () => void }) {
  const [confirmando, confirmar] = useState(false), [gravando, gravar] = useState(false), [erro, setErro] = useState<string | null>(null)
  const trava = useRef(false)
  async function desfazer(): Promise<void> {
    if (trava.current) return
    trava.current = true; gravar(true); setErro(null)
    try {
      const resultado = await operacoesCaixa.estornar(fato, hoje())
      if (!resultado.ok) { setErro(fraseDaGuardaDoCaixa(resultado.motivo)); return }
      confirmar(false); aoSalvar()
    } catch { setErro(P.falhaAoGravar) }
    finally { trava.current = false; gravar(false) }
  }
  return <details className="mt-2">
    <summary className="min-h-11 cursor-pointer py-2 font-semibold text-acento">{P.corrigir}</summary>
    <p>{P.corrigirExplicacao}</p>
    <Botao tipo="secundario" aoTocar={aoCorrigir} desabilitado={gravando}>{P.corrigir}</Botao>
    <p>{P.desfazerExplicacao}</p>
    {confirmando ? <div className="grid gap-2">
      <Botao tipo="secundario" aoTocar={() => void desfazer()} desabilitado={gravando}>{P.confirmarDesfazer}</Botao>
      <Botao tipo="secundario" aoTocar={() => confirmar(false)} desabilitado={gravando}>{P.manter}</Botao>
    </div> : <Botao tipo="secundario" aoTocar={() => confirmar(true)} desabilitado={gravando}>{P.desfazer}</Botao>}
    {erro && <p role="alert" className="text-atraso">{erro}</p>}
  </details>
}

function ResumoFato({ fato, fatos }: { fato: FatoCaixa; fatos: readonly FatoCaixa[] }) {
  const alvo = fato.tipo === 'estorno' ? fatos.find((f) => f.id === fato.alvo.id && f.revisao === fato.alvo.revisao && f.tipo !== 'estorno') : undefined
  return fato.tipo === 'estorno' ? <p>{P.desfeita}{alvo && alvo.tipo !== 'estorno' ? `: ${alvo.categoria} · ${emReais(alvo.valor)} · ${dataCompleta(alvo.data)}` : ''} · {dataCompleta(fato.data)}</p>
    : <p>{natureza(fato)} · {fato.categoria} · {emReais(fato.valor)} · {dataCompleta(fato.data)} · {fato.classificacao === 'negocio' ? P.negocio : P.pessoal}</p>
}

function HistoricoCaixa({ estado, mes, corte }: { estado: EstadoLocalCaixa; mes: string; corte: CorteCaixa }) {
  // Inclui versões antigas e tentativas retiradas; a data da correção não é um novo movimento.
  const fatos = [...estado.fatos, ...estado.versoes.flatMap((v) => v.grupo.fatos)]
  function noCorte(f: FatoCaixa): boolean {
    const movimento = f.tipo === 'estorno' ? fatos.find((alvo) => alvo.id === f.alvo.id && alvo.revisao === f.alvo.revisao && alvo.tipo !== 'estorno') : f
    return !!movimento && movimento.tipo !== 'estorno' && movimento.data.slice(0, 7) === mes && (corte === 'tudo' || movimento.classificacao === corte)
  }
  const versoes = estado.versoes.filter((v) => v.grupo.fatos.some(noCorte))
    .sort((a, b) => b.id.localeCompare(a.id))
  if (!versoes.length) return null
  function situacao(v: VersaoCaixa): string {
    if (v.foraDaProjecao) return P.fora
    if (v.problema) return P.recusada
    if (v.aceita) return P.enviada
    const anterior = estado.versoes.some((outra) => outra.operacaoId === v.operacaoId && outra.grupo.operacao.revisao > v.grupo.operacao.revisao)
    return anterior ? P.anterior : P.anotada
  }
  return <details className="mt-5 [overflow-wrap:anywhere]">
    <summary className="min-h-11 cursor-pointer py-2 font-semibold text-acento">{P.historico}</summary>
    {versoes.map((v) => <div key={v.id} data-caixa-versao={v.id} className="border-b border-borda py-3">
      {v.grupo.operacao.tipo === 'correcao' && <p className="font-semibold">{P.correcao}</p>}
      {v.grupo.fatos.map((f) => <ResumoFato key={f.id} fato={f} fatos={fatos} />)}
      <p className="text-suave">{situacao(v)}</p>
    </div>)}
  </details>
}
