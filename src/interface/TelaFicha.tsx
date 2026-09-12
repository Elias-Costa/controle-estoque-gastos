import { useEffect } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { emReais } from '../dominio/dinheiro.ts'
import type { Id } from '../dominio/ficha.ts'
import { diaCurto, hoje } from './datas.ts'
import { linhasDaFicha, resumir, type LinhaDaFicha, type ResumoDaFicha } from './leitura-da-ficha.ts'
import { linhaDaProxima, PALAVRAS } from './palavras-da-ficha.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/**
 * A ficha (RF-02): a tela que substitui a página do caderno. No topo, sem rolagem, quanto ela
 * deve hoje e qual a próxima parcela — vencida em destaque; abaixo, o histórico em ordem
 * cronológica inversa. Tudo derivado (RN-01): nenhum número aqui é lido de um campo.
 *
 * Fiel ao protótipo validado em 2026-09-08. O que falta é de outras etapas, de propósito
 * (D-044): "Recebi" é E-11 e "Vender fiado para ela" é E-10 — um botão que não faz nada
 * é defeito, não promessa.
 */
export function TelaFicha({ clienteId, aoVoltar }: { clienteId: Id; aoVoltar: () => void }) {
  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    const dia = hoje()
    return { resumo: resumir(cliente, ficha, dia), linhas: linhasDaFicha(ficha, dia) }
  }, clienteId)

  // Cliente que sumiu entre um toque e outro (só por outro aparelho): a lista é o lugar certo.
  const sumiu = leitura.estado === 'lido' && leitura.valor === null
  useEffect(() => {
    if (sumiu) aoVoltar()
  }, [sumiu, aoVoltar])

  if (leitura.estado !== 'lido' || leitura.valor === null) {
    return (
      <main className="tela">
        <Topo titulo="" aoVoltar={aoVoltar} />
        {leitura.estado === 'falhou' && <p className="text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
      </main>
    )
  }

  const { resumo, linhas } = leitura.valor
  return (
    <main className="tela">
      <Topo titulo={resumo.cliente.nome} subtitulo={resumo.cliente.apelido} aoVoltar={aoVoltar} />
      <CartaoDeSaldo resumo={resumo} />
      <h2 className="mt-7 mb-2 text-[1rem] font-semibold text-suave">{PALAVRAS.oQueAconteceu}</h2>
      <Historico linhas={linhas} />
    </main>
  )
}

/**
 * RF-02 exige saldo e próxima parcela "no topo e sem rolagem". O cartão é curto de propósito:
 * o que compete com ele por espaço é o histórico, e o histórico pode rolar.
 */
function CartaoDeSaldo({ resumo }: { resumo: ResumoDaFicha }) {
  const vencida = resumo.proxima?.vencida === true
  return (
    <div className="rounded-2xl border border-borda bg-papel px-[1.125rem] pt-4 pb-[1.125rem]">
      <p className="m-0 text-[0.95rem] text-suave">{PALAVRAS.deve}</p>
      <p className="m-0 mt-0.5 text-[2.75rem] leading-[1.05] font-bold tabular-nums">
        {resumo.saldo === 0n ? PALAVRAS.nada : emReais(resumo.saldo)}
      </p>
      <p
        className={
          vencida
            ? 'mt-2 inline-block rounded-lg bg-atraso-fundo px-2.5 py-1.5 text-[1rem] font-semibold text-atraso'
            : 'm-0 mt-2 text-[1rem] text-suave'
        }
      >
        {linhaDaProxima(resumo.proxima, resumo.vazia)}
      </p>
    </div>
  )
}

/** O histórico: data, o que foi, quanto. Vencida em vermelho; pagamento em cinza; estornado riscado (RN-07). */
function Historico({ linhas }: { linhas: LinhaDaFicha[] }) {
  if (linhas.length === 0) return <p className="m-0 text-suave">{PALAVRAS.nadaAnotado}</p>
  return (
    <ul className="m-0 list-none p-0">
      {linhas.map((linha) => {
        const destaque = linha.tipo === 'vencida' ? 'font-semibold text-atraso' : ''
        const apagado = linha.tipo === 'pagamento' ? 'text-suave' : ''
        const riscado = linha.estornado ? 'line-through text-suave' : ''
        return (
          <li key={linha.chave} className={`flex justify-between gap-3 border-b border-borda py-3 ${apagado} ${riscado}`}>
            <span className="w-[4.25rem] flex-none text-suave tabular-nums">{diaCurto(linha.data)}</span>
            <span className={`flex-1 ${destaque}`}>{linha.descricao}</span>
            <span className={`flex-none whitespace-nowrap tabular-nums ${destaque}`}>{emReais(linha.valor)}</span>
          </li>
        )
      })}
    </ul>
  )
}
