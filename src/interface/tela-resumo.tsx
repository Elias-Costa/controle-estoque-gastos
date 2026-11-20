import { Fragment, useEffect, useId, useMemo, useState } from 'react'
import { banco, repositorioPrazoEncalhe } from '../dados/instancia.ts'
import { lerDadosIndicadores } from '../dados/leitura-indicadores.ts'
import type { PreferenciaEncalhe } from '../dados/prazo-encalhe.ts'
import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { Dia } from '../dominio/ficha.ts'
import { projetarIndicadores } from '../dominio/indicadores.ts'
import { diaValido } from '../dominio/regras-estoque.ts'
import { CLASSES_DE_CAMPO, Rotulo } from './Campo.tsx'
import { diaCurto, hoje } from './datas.ts'
import { EditorPrazoEncalhe } from './editor-prazo-encalhe.tsx'
import { GraficoDoResumo } from './grafico-do-resumo.tsx'
import { PALAVRAS_DO_ESTOQUE as E } from './palavras-do-estoque.ts'
import { PALAVRAS_DOS_PRODUTOS as Q } from './palavras-dos-produtos.ts'
import { PALAVRAS_DO_RESUMO as P } from './palavras-do-resumo.ts'
import { Topo } from './Topo.tsx'
import { useLeitura, type Leitura } from './useLeitura.ts'

type Indicadores = ReturnType<typeof projetarIndicadores>
const CARTAO = 'min-w-0 rounded-xl border border-borda bg-papel p-3 [overflow-wrap:anywhere]'
const MESES = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const OPCOES_DE_MES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

function nomeDoMes(mes: string): string {
  return MESES.format(new Date(`${mes}-01T00:00:00Z`))
}

function useDiaDoResumo(): Dia {
  const [dia, setDia] = useState(hoje)
  useEffect(() => {
    let alarme: ReturnType<typeof setTimeout>
    function atualizar() {
      clearTimeout(alarme)
      const agora = new Date()
      setDia(hoje(agora))
      const meiaNoite = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1)
      alarme = setTimeout(atualizar, meiaNoite.getTime() - agora.getTime())
    }
    atualizar()
    // O relógio pode ter avançado enquanto o app estava suspenso (contrato de F4).
    document.addEventListener('visibilitychange', atualizar)
    window.addEventListener('focus', atualizar)
    return () => {
      clearTimeout(alarme)
      document.removeEventListener('visibilitychange', atualizar)
      window.removeEventListener('focus', atualizar)
    }
  }, [])
  return dia
}

/** RF-19–22. A posição de hoje e as anotações do mês partem da leitura local de E-41. */
export function TelaResumo({ aoVoltar }: { aoVoltar: () => void }) {
  const dia = useDiaDoResumo()
  const mesAtual = dia.slice(0, 7)
  const mesId = useId()
  const [escolha, escolherMes] = useState<{ ano: string; mes: string }>()
  const anoEscolhido = escolha?.ano ?? mesAtual.slice(0, 4)
  const mesEscolhido = escolha?.mes ?? mesAtual.slice(5, 7)
  const entrada = `${anoEscolhido}-${mesEscolhido}`
  const anoValido = /^\d{4}$/.test(anoEscolhido) && anoEscolhido >= '0001' && anoEscolhido <= mesAtual.slice(0, 4)
  const mesValido = anoValido && diaValido(`${entrada}-01`) && entrada <= mesAtual
  const mes = mesValido ? entrada : mesAtual
  const dados = useLeitura(() => lerDadosIndicadores(banco), 'resumo')
  const [prazo, setPrazo] = useState<Leitura<PreferenciaEncalhe | undefined>>({ estado: 'lendo' })
  useEffect(() => repositorioPrazoEncalhe.assinar(
    (valor) => setPrazo({ estado: 'lido', valor }),
    () => setPrazo({ estado: 'falhou' }),
  ), [])
  const dias = prazo.estado === 'lido' ? prazo.valor?.dias : undefined
  const leitura = useMemo((): Leitura<Indicadores> => {
    if (dados.estado !== 'lido') return dados
    try {
      return { estado: 'lido', valor: projetarIndicadores(dados.valor, dia, mes, dias) }
    } catch {
      return { estado: 'falhou' }
    }
  }, [dados, dia, mes, dias])

  return <main className="tela">
    <Topo titulo={P.titulo} aoVoltar={aoVoltar} />
    {leitura.estado === 'lendo' && <p role="status">{P.lendo}</p>}
    {leitura.estado === 'falhou' && <p role="alert">{P.falhaLeitura}</p>}
    {leitura.estado === 'lido' && <div className="grid gap-4">
      <AReceber dados={leitura.valor.aReceber} />
      <fieldset className="m-0 min-w-0 border-0 p-0"
        aria-describedby={!mesValido ? `${mesId}-ajuda` : undefined}>
        <legend className="font-semibold">{P.mes}</legend>
        <div className="flex flex-wrap gap-x-3">
          <div className="min-w-0 flex-[2] basis-32">
            <Rotulo para={mesId}>Mês</Rotulo>
            <select id={mesId} className={CLASSES_DE_CAMPO} value={mesEscolhido}
              aria-invalid={anoValido && !mesValido || undefined}
              onChange={(e) => escolherMes({ ano: anoEscolhido, mes: e.target.value })}>
              {OPCOES_DE_MES.map((rotulo, i) => <option key={rotulo} value={String(i + 1).padStart(2, '0')}>{rotulo}</option>)}
            </select>
          </div>
          <div className="min-w-0 flex-1 basis-20">
            <Rotulo para={`${mesId}-ano`}>Ano</Rotulo>
            <input id={`${mesId}-ano`} className={CLASSES_DE_CAMPO} inputMode="numeric" maxLength={4} value={anoEscolhido}
              aria-invalid={!anoValido || undefined}
              onChange={(e) => escolherMes({ ano: e.target.value, mes: mesEscolhido })} />
          </div>
        </div>
        {!mesValido && <p id={`${mesId}-ajuda`} className="mt-1 text-atraso">{P.mesInvalido}</p>}
      </fieldset>
      {mesValido && <><Lucro dados={leitura.valor.lucro} /><Vendas dados={leitura.valor.vendas} /></>}
      <Estoque dados={leitura.valor.estoque} prazo={prazo} />
    </div>}
  </main>
}

function Valor({ valor }: { valor: Centavos }) {
  const grupos = emReais(valor).split('.')
  // Permite quebrar valores extensos junto dos milhares e manter os centavos com o último grupo.
  return <span className={valor < 0n ? 'text-atraso' : undefined}>
    {grupos.map((grupo, i) => <Fragment key={i}>{i > 0 && <>.<wbr /></>}{grupo}</Fragment>)}
  </span>
}

function Valores({ linhas }: { linhas: readonly (readonly [string, Centavos])[] }) {
  return <dl className="mt-2 space-y-1">
    {linhas.map(([nome, valor]) => <div key={nome} className="flex flex-wrap justify-between gap-x-3">
      <dt>{nome}</dt>
      <dd className="font-semibold"><Valor valor={valor} /></dd>
    </div>)}
  </dl>
}

function AReceber({ dados }: { dados: Indicadores['aReceber'] }) {
  return <section className={CARTAO} aria-labelledby="resumo-a-receber">
    <h2 id="resumo-a-receber" className="font-semibold">{P.aReceber}</h2>
    <p className="my-1 text-3xl font-semibold leading-tight"><Valor valor={dados.total} /></p>
    <p className="text-suave">{dados.devedoras === 1 ? '1 fichinha com saldo' : `${dados.devedoras} fichinhas com saldo`}</p>
    <Valores linhas={[[P.vencido, dados.vencido], [P.aVencer, dados.aVencer]]} />
    <div className="mt-3 border-t border-borda pt-3">
      <h3 className="font-semibold">Vencido por tempo de atraso</h3>
      {dados.vencido > 0n && <GraficoDoResumo valores={dados.faixas} />}
      <Valores linhas={P.faixas.map((faixa, i) => [faixa, dados.faixas[i] ?? 0n])} />
    </div>
    {dados.desativadas > 0 && <div className="mt-3 border-t border-borda pt-3">
      <Valores linhas={[[dados.desativadas === 1 ? 'Em 1 fichinha desativada' : `Em ${dados.desativadas} fichinhas desativadas`, dados.saldoDesativadas]]} />
    </div>}
  </section>
}

function Lucro({ dados }: { dados: Indicadores['lucro'] }) {
  const limites = [
    ['Itens avulsos', dados.avulsos],
    ['A entregar', dados.aEntregar],
    ['Cancelados sem entrega', dados.canceladosSemEntrega],
    ['Itens sem custo conhecido', dados.semCusto],
  ] as const
  const avisos = limites.filter(([, valor]) => valor !== 0n)
  return <section className={CARTAO} aria-labelledby="resumo-lucro">
    <h2 id="resumo-lucro" className="font-semibold">{P.lucro}</h2>
    <p className="my-1 text-2xl font-semibold leading-tight"><Valor valor={dados.resultado} /></p>
    <p className="text-suave">{P.coberturaLucro}</p>
    <Valores linhas={[
      ['Vendas entregues com custo conhecido', dados.vendasApuraveis],
      ['Cancelamentos e devoluções', -dados.devolucoesApuraveis],
      ['Custo das entregas', -dados.custoDasEntregas],
      ['Custo recuperado nas devoluções', dados.custoDosRetornos],
      ['Despesas do negócio', -dados.despesas],
      ['Descontos de quitação', -dados.descontosQuitacao],
    ]} />
    {(avisos.length > 0 || dados.itensSemCusto.length > 0 || dados.retornosSemCusto.length > 0 || dados.entregasAConferir.length > 0)
      && <div className="mt-3 border-t border-borda pt-3">
        <h3 className="font-semibold">Fora do lucro calculável</h3>
        {avisos.length > 0 && <Valores linhas={avisos} />}
        {dados.itensSemCusto.length > 0 && <p>Há itens entregues sem custo conhecido.</p>}
        {dados.retornosSemCusto.length > 0 && <p>Há devoluções cujo custo não pôde ser calculado.</p>}
        {dados.entregasAConferir.length > 0 && <p>Há itens com quantidade entregue a conferir.</p>}
      </div>}
  </section>
}

type PontoDaSerie = { chave: string; rotulo: string; eixo?: string; valor: Centavos; temAnotacoes: boolean }

function Serie({ titulo, pontos }: { titulo: string; pontos: readonly PontoDaSerie[] }) {
  const temAnotacoes = pontos.some((p) => p.temAnotacoes)
  const primeiro = pontos[0]
  const ultimo = pontos.at(-1)
  return <div className="mt-4 border-t border-borda pt-3">
    <h3 className="mb-2 font-semibold">{titulo}</h3>
    {temAnotacoes ? <GraficoDoResumo valores={pontos.map((p) => p.temAnotacoes ? p.valor : undefined)} /> : <p>{P.semVendas}</p>}
    <p aria-hidden="true" className="flex justify-between gap-x-1 text-suave">
      <span>{primeiro?.eixo ?? primeiro?.rotulo}</span>
      {ultimo !== primeiro && <span>{ultimo?.eixo ?? ultimo?.rotulo}</span>}
    </p>
    {temAnotacoes && <details>
      <summary className="min-h-11 cursor-pointer py-2 font-semibold text-tinta focus-visible:outline-2 focus-visible:outline-acento">
        Ver valores {titulo === P.porDia ? 'por dia' : 'por mês'}
      </summary>
      <dl className="space-y-1">
        {pontos.map(({ chave, rotulo, valor, temAnotacoes }) => <div key={chave} className="flex flex-wrap justify-between gap-x-3">
          <dt>{rotulo}</dt>
          <dd>{temAnotacoes ? <Valor valor={valor} /> : P.semAnotacao}</dd>
        </div>)}
      </dl>
    </details>}
  </div>
}

function dataCompleta(dia: Dia): string {
  return `${diaCurto(dia)}/${dia.slice(0, 4)}`
}

function Vendas({ dados }: { dados: Indicadores['vendas'] }) {
  const comparacao = [[P.mesConsultado, dados.consultado], [P.mesAnterior, dados.anterior]] as const
  return <section className={CARTAO} aria-labelledby="resumo-vendas">
    <h2 id="resumo-vendas" className="font-semibold">{P.vendas}</h2>
    <dl className="mt-2 grid gap-2">
      {comparacao.map(([rotulo, { inicio, fim, valor, temAnotacoes }]) => <Fragment key={rotulo}>
        <dt className="font-semibold">{rotulo} <span className="block font-normal text-suave">{dataCompleta(inicio)} a {dataCompleta(fim)}</span></dt>
        <dd>{temAnotacoes ? <Valor valor={valor} /> : P.semVendas}</dd>
      </Fragment>)}
    </dl>
    <Serie titulo={P.porDia} pontos={dados.diaria.map((p) => ({ ...p, chave: p.dia, rotulo: diaCurto(p.dia) }))} />
    <Serie titulo={P.porMes} pontos={dados.mensal.map((p) => ({
      ...p, chave: p.mes, rotulo: nomeDoMes(p.mes), eixo: `${p.mes.slice(5, 7)}/${p.mes.slice(2, 4)}`,
    }))} />
  </section>
}

type ProdutoNoResumo = Indicadores['estoque']['repor'][number] & { dias?: number }

function Produtos({ lista, mostrarReposicao = false }: { lista: readonly ProdutoNoResumo[]; mostrarReposicao?: boolean }) {
  return <ul className="mt-2 divide-y divide-borda">
    {lista.map(({ produto, fisico, prometido, disponivel, falta, contagensAfetadas, divergenciaFisica, dias }) => <li key={produto.id} className="py-2">
      <p className="font-semibold">{produto.nome}</p>
      {(produto.marca || produto.codigoCatalogo) && <p className="text-suave">{[produto.marca, produto.codigoCatalogo].filter(Boolean).join(' · ')}</p>}
      <p>{Q.disponivel}: {disponivel}</p>
      {mostrarReposicao && <>
        <p>{E.fisico}: {fisico} · {Q.prometido}: {prometido} · {Q.minimo}: {produto.estoqueMinimo}</p>
        {falta > 0 && <p className="font-semibold">{Q.faltam} {falta}</p>}
      </>}
      {dias !== undefined && <p>Há {dias} {dias === 1 ? 'dia' : 'dias'}</p>}
      {contagensAfetadas && <p className="font-semibold text-atraso">{E.afetada}</p>}
      {divergenciaFisica && <p className="font-semibold text-atraso">{E.divergencia}</p>}
    </li>)}
  </ul>
}

function Estoque({ dados, prazo }: { dados: Indicadores['estoque']; prazo: Leitura<PreferenciaEncalhe | undefined> }) {
  return <section className={CARTAO} aria-labelledby="resumo-estoque">
    <h2 id="resumo-estoque" className="font-semibold">{P.estoque}</h2>
    <h3 className="mt-3 font-semibold">{P.repor}</h3>
    {dados.repor.length > 0 ? <Produtos lista={dados.repor} mostrarReposicao /> : <p>{Q.vazioNoMinimo}</p>}
    <div className="mt-3 border-t border-borda pt-3">
      <h3 className="font-semibold">{P.encalhados}</h3>
      {prazo.estado === 'lendo' && <p role="status">{P.lendo}</p>}
      {prazo.estado === 'falhou' && <p role="alert">{P.falhaLeituraPrazo}</p>}
      {prazo.estado === 'lido' && <>
        <p className="text-suave">Disponíveis para venda, parados há mais de {dados.prazo} dias.</p>
        {dados.encalhados.length > 0 ? <Produtos lista={dados.encalhados} /> : <p>Nenhum produto passou desse prazo.</p>}
        {dados.semData.length > 0 && <>
          <h4 className="mt-3 font-semibold">Sem data para contar o tempo parado</h4>
          <Produtos lista={dados.semData} />
        </>}
        <EditorPrazoEncalhe preferencia={prazo.valor} />
      </>}
    </div>
  </section>
}
