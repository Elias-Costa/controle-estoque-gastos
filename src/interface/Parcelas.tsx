import { useState } from 'react'
import { emReais } from '../dominio/dinheiro.ts'
import { CLASSES_DE_CAMPO, CLASSES_DE_CAMPO_COMPACTO } from './Campo.tsx'
import { EntradaDeDinheiro, LeituraDoValor } from './CampoDeDinheiro.tsx'
import { Vezes } from './Opcoes.tsx'
import { PALAVRAS_DA_VENDA, quandoDaParcela } from './palavras-da-venda.ts'
import { textoDeCentavos, type EdicaoDeParcela, type ParcelaMontada } from './rascunho-da-venda.ts'

/**
 * O bloco das parcelas (E-10, D-045; extraído de `TelaVenda` em E-14 para o saldo anterior
 * usar o mesmo, D-049): "Em quantas vezes" (1×–N×), a lista das parcelas montadas — só
 * leitura, como o protótipo — e, atrás de um toque, "Mudar datas ou valores", que troca cada
 * linha por campo de data e campo de dinheiro. Quem monta as parcelas é `montarParcelas`
 * (`rascunho-da-venda.ts`); aqui só se mostra e se recolhe o que ela mexeu, pela posição.
 *
 * `lista` diz se a lista aparece: a venda a mostra sempre que há total; o saldo anterior só
 * com 2× ou mais — com 1×, o campo "Vence em" já é a parcela inteira (D-044).
 */
export function Parcelas({
  maximo,
  vezes,
  parcelas,
  edicoes,
  lista,
  aoMudarVezes,
  aoMudarParcela,
}: {
  maximo: number
  vezes: number
  parcelas: readonly ParcelaMontada[]
  edicoes: readonly EdicaoDeParcela[]
  lista: boolean
  aoMudarVezes: (vezes: number) => void
  aoMudarParcela: (posicao: number, mudanca: EdicaoDeParcela) => void
}) {
  const [editando, setEditando] = useState(false)
  return (
    <>
      <Vezes rotulo={PALAVRAS_DA_VENDA.emQuantasVezes} maximo={maximo} valor={vezes} aoEscolher={aoMudarVezes} />
      {lista && (
        <>
          <ul className="m-0 mt-3 list-none p-0">
            {parcelas.map((parcela, posicao) =>
              editando ? (
                <ParcelaEditavel key={posicao} posicao={posicao} parcela={parcela} edicao={edicoes[posicao] ?? {}} aoMudar={(mudanca) => aoMudarParcela(posicao, mudanca)} />
              ) : (
                <li key={posicao} className="flex justify-between border-b border-borda py-2 tabular-nums">
                  <span className="text-suave">{quandoDaParcela(posicao + 1, parcela.vencimento)}</span>
                  <span className={parcela.editada ? 'font-semibold' : ''}>{emReais(parcela.valor)}</span>
                </li>
              ),
            )}
          </ul>
          {!editando && (
            <button type="button" className="mt-1 min-h-11 border-0 bg-transparent p-0 text-[1rem] text-acento underline" onClick={() => setEditando(true)}>
              {PALAVRAS_DA_VENDA.mudarParcelas}
            </button>
          )}
        </>
      )}
    </>
  )
}

/**
 * Uma parcela em edição (D-012, D-045): "1ª", o campo de data e o campo de valor. O valor
 * vazio mostra, como exemplo, o que a divisão dá — digitar por cima é "combinei outro";
 * apagar é "deixa o sistema dividir de novo".
 */
function ParcelaEditavel({
  posicao,
  parcela,
  edicao,
  aoMudar,
}: {
  posicao: number
  parcela: ParcelaMontada
  edicao: EdicaoDeParcela
  aoMudar: (mudanca: EdicaoDeParcela) => void
}) {
  const ordem = `${posicao + 1}ª`
  return (
    <li className="border-b border-borda py-2">
      <div className="flex items-center gap-2">
        <span className="w-7 flex-none text-suave">{ordem}</span>
        <input
          className={`${CLASSES_DE_CAMPO} min-w-0 flex-1`}
          type="date"
          aria-label={`${ordem} vence em`}
          value={edicao.vencimento ?? parcela.vencimento}
          onChange={(evento) => aoMudar({ vencimento: evento.target.value })}
        />
        <EntradaDeDinheiro
          className={`${CLASSES_DE_CAMPO_COMPACTO} w-[7rem] flex-none text-right tabular-nums`}
          texto={edicao.valorTexto ?? ''}
          aoMudar={(valorTexto) => aoMudar({ valorTexto })}
          exemplo={textoDeCentavos(parcela.valor)}
          rotuloAcessivel={`${ordem} valor`}
        />
      </div>
      <LeituraDoValor texto={edicao.valorTexto ?? ''} className="mt-1 text-right text-[1.125rem]" />
    </li>
  )
}
