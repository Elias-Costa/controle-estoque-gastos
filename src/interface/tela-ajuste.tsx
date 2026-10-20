import { useId, useRef, useState } from 'react'
import { operacoesEstoque, repositorioEstoque } from '../dados/instancia.ts'
import type { EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { chaveDoEfeito, referenciaDoEfeito, type ReferenciaEfeito } from '../dominio/estoque.ts'
import { Botao } from './Botao.tsx'
import { Campo, CLASSES_DE_CAMPO, Rotulo } from './Campo.tsx'
import { hoje } from './datas.ts'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { lerEstoque } from './leitura-de-estoque.ts'
import { fraseDaGuardaDoAjuste, MOTIVOS_DO_AJUSTE, PALAVRAS_DO_ESTOQUE as P, quantidadeComSinal } from './palavras-do-estoque.ts'
import { conferirAjuste, efeitoDoAjuste, rascunhoDoAjuste, type AjusteDeEstoque, type RascunhoDoAjuste } from './rascunho-do-ajuste.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** RF-14/25: ajuste local com motivo, data e efeito visível; confirmar nunca espera rede. */
export function TelaAjuste({ produtoId, alvo, conferir = false, aoVoltar, aoSalvar }: {
  produtoId: string; alvo?: ReferenciaEfeito; conferir?: boolean
  aoVoltar: () => void; aoSalvar: () => void
}) {
  const leitura = useLeitura(() => repositorioEstoque.lerEstado(), `${produtoId}/${alvo ? chaveDoEfeito(alvo) : 'novo'}`)
  const movimento = leitura.estado === 'lido' && alvo ? leitura.valor.movimentos.find((item) => chaveDoEfeito(item) === chaveDoEfeito(alvo)) : undefined
  const original = movimento?.tipo === 'saida' || (movimento?.tipo === 'contagem' && movimento.motivo === 'conferencia') ? movimento : undefined
  if (leitura.estado !== 'lido' || (alvo && !original)) return <main className="tela">
    <Topo titulo={P.ajuste} aoVoltar={aoVoltar} /><p role="status">{leitura.estado === 'lendo' ? P.lendo : P.falhaLeitura}</p>
  </main>
  return <FormularioAjuste estado={leitura.valor} produtoId={produtoId} original={original} conferir={conferir} aoVoltar={aoVoltar} aoSalvar={aoSalvar} />
}

function FormularioAjuste({ estado, produtoId, original, conferir, aoVoltar, aoSalvar }: {
  estado: EstadoLocalEstoque; produtoId: string; original?: AjusteDeEstoque; conferir: boolean
  aoVoltar: () => void; aoSalvar: () => void
}) {
  const [alvo] = useState(original)
  const [rascunho, setRascunho] = useState(() => rascunhoDoAjuste(produtoId, hoje(), alvo, conferir))
  const [gravando, setGravando] = useState(false), [erro, setErro] = useState<string | null>(null)
  const trava = useRef(false), motivoId = useId(), quantidadeId = useId()
  const estoque = lerEstoque(estado, produtoId), contagem = rascunho.motivo === 'conferencia'
  const conferencia = conferirAjuste(rascunho, hoje())
  const motivos = MOTIVOS_DO_AJUSTE.filter((item) => !alvo || (alvo.tipo === 'contagem' ? item.valor === 'conferencia' : item.valor !== 'conferencia'))
  function mudar(mudanca: Partial<RascunhoDoAjuste>): void { setRascunho((anterior) => ({ ...anterior, ...mudanca })); setErro(null) }
  async function salvar(): Promise<void> {
    if (!conferencia.ok || trava.current) return
    trava.current = true; setGravando(true); setErro(null)
    try {
      const resultado = alvo
        ? await operacoesEstoque.corrigirRegistroMovimento(referenciaDoEfeito(alvo), conferencia.valor)
        : await operacoesEstoque.registrarMovimento(conferencia.valor)
      if (!resultado.ok) { setErro(fraseDaGuardaDoAjuste(resultado.motivo)); return }
      aoSalvar()
    } catch { setErro(P.falhaGravacao) }
    finally { trava.current = false; setGravando(false) }
  }
  return <main className="tela">
    <Topo titulo={alvo ? P.corrigirAjuste : conferir ? P.conferir : P.ajuste} aoVoltar={() => { if (!trava.current) aoVoltar() }} />
    <IndicadorDeEnvio />
    <h2 className="break-words">{estoque.produto.nome}</h2>
    <p>{P.fisico}: <strong>{estoque.fisico}</strong></p>
    {estoque.contagensAfetadas && <p role="status" className="text-atraso">{P.afetada}</p>}
    {alvo && <p>{P.correcaoAjusteExplicacao}</p>}
    <fieldset disabled={gravando} className="min-w-0 border-0 p-0">
      <Rotulo para={motivoId}>{P.motivo}</Rotulo>
      <select id={motivoId} className={CLASSES_DE_CAMPO} value={rascunho.motivo} disabled={alvo?.tipo === 'contagem'} onChange={(evento) => {
        const motivo = MOTIVOS_DO_AJUSTE.find((item) => item.valor === evento.target.value)?.valor ?? ''
        mudar({ motivo, quantidadeTexto: (motivo === 'conferencia') !== contagem ? '' : rascunho.quantidadeTexto })
      }}>
        <option value="">{P.escolherMotivo}</option>
        {motivos.map((item) => <option key={item.valor} value={item.valor}>{item.rotulo}</option>)}
      </select>
      {contagem && <p>{alvo ? P.corrigirContagemExplicacao : P.contagemExplicacao}</p>}
      <Rotulo para={quantidadeId}>{contagem ? P.contado : P.quantidade}</Rotulo>
      <input id={quantidadeId} className={CLASSES_DE_CAMPO} type="text" inputMode="numeric" autoComplete="off" value={rascunho.quantidadeTexto} onChange={(evento) => mudar({ quantidadeTexto: evento.target.value })} />
      <Campo rotulo={contagem ? P.dataContagem : P.data} tipo="date" valor={rascunho.data} aoMudar={(data) => mudar({ data })} />
    </fieldset>
    {conferencia.ok && <p className="text-2xl font-semibold" aria-live="polite">{alvo ? P.efeitoCorrigido : P.efeito}: {quantidadeComSinal(efeitoDoAjuste(conferencia.valor, estoque.fisico, alvo))}</p>}
    {!conferencia.ok && <p role="status" className="font-semibold text-atraso">{fraseDaGuardaDoAjuste(conferencia.motivo)}</p>}
    {erro && <p role="alert" className="font-semibold text-atraso">{erro}</p>}
    <div className="rodape-acao"><Botao tipo="principal" aoTocar={() => void salvar()} desabilitado={!conferencia.ok || gravando}>{gravando ? P.salvando : P.salvar}</Botao></div>
  </main>
}
