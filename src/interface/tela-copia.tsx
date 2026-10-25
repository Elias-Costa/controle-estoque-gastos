import { useEffect, useState } from 'react'
import { banco } from '../dados/instancia.ts'
import { ErroCopia } from '../dados/formato-copia.ts'
import { criarRepositorioCopia } from '../dados/repositorio-copia.ts'
import { copia } from '../sincronizacao/instancia.ts'
import { Botao } from './Botao.tsx'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { emReais } from '../dominio/dinheiro.ts'
import { totalDaVenda, totalDoDebito, type Lancamento } from '../dominio/ficha.ts'

const repo = criarRepositorioCopia(banco)
function frase(erro: unknown): string {
  if (!(erro instanceof ErroCopia)) return 'Não deu para concluir. Suas anotações continuam guardadas. Você pode tentar de novo.'
  switch (erro.motivo) {
    case 'conta': return 'Esta cópia pertence a outra conta ou a outro endereço do aplicativo. Peça ajuda para conferir.'
    case 'vazia': return 'Este aparelho já tem anotações. Para usar uma cópia, comece em um aparelho sem fichinhas, produtos e anotações.'
    case 'foto': return 'A cópia completa ainda não ficou pronta: falta conferir uma foto. Tente de novo com internet. Suas anotações continuam aqui.'
    case 'limite': return 'Esta cópia é maior do que o aplicativo consegue preparar ou abrir agora. Peça ajuda; nenhuma anotação foi retirada.'
    case 'entrar': return 'Entre na sua conta para identificar de quem é a cópia.'
    case 'estagio': return 'Esta preparação mudou. Volte a abrir esta tela para continuar ou escolher o arquivo de novo.'
    case 'arquivo': return 'Não deu para conferir o arquivo inteiro. Escolha uma cópia completa criada pelo aplicativo.'
  }
}
function resumo(l: Lancamento): string {
  const valor = l.tipo === 'venda' ? totalDaVenda(l) : l.tipo === 'saldo-anterior' ? totalDoDebito(l) : 'valor' in l ? l.valor : undefined
  return `${l.data.split('-').reverse().join('/')} · ${l.tipo === 'estorno' ? 'Correção' : l.tipo === 'recebimento' ? 'Recebi' : l.tipo === 'venda' ? 'Venda' : 'Anotação'}${valor === undefined ? '' : ` · ${emReais(valor)}`}`
}
/** RF-28: preparação retomável e seleção explícita, sem limpeza/substituição de dados. */
export function TelaCopia({ aoVoltar, aoEntrar }: { aoVoltar: () => void; aoEntrar: () => void }) {
  const [revisao, reler] = useState(0), [trabalhando, trabalhar] = useState(false)
  const [aviso, avisar] = useState<string>(), [arquivo, escolher] = useState<File>()
  const [download, oferecer] = useState<{ url: string; nome: string }>()
  const leitura = useLeitura(async () => ({ estagios: await repo.listar(), restauracao: await repo.restauracao(),
    vinculo: await repo.vinculo(), evidencias: await banco.evidenciasCopia.toArray(), clientes: await banco.clientes.toArray() }), `copia/${revisao}`)
  const dados = leitura.estado === 'lido' ? leitura.valor : undefined
  useEffect(() => {
    let ativa = true
    // O login pode ter acabado antes de o motor gravar o vínculo local. Resolver sem
    // pedir à usuária uma confirmação que o app consegue fazer sozinho (RI-08).
    void copia.vinculo().then(() => { if (ativa) reler((n) => n + 1) }, (erro: unknown) => {
      if (ativa && (!(erro instanceof ErroCopia) || erro.motivo !== 'entrar')) avisar(frase(erro))
    })
    return () => { ativa = false }
  }, [])
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url) }, [download])
  async function executar(acao: () => Promise<void>) {
    if (trabalhando) return
    trabalhar(true); avisar(undefined)
    try { await acao() } catch (erro) { avisar(frase(erro)) }
    finally { trabalhar(false); reler((n) => n + 1) }
  }
  async function preparar(id?: string) {
    await executar(async () => {
      const resultado = await copia.exportar(id)
      oferecer({ url: URL.createObjectURL(resultado.arquivo), nome: resultado.nome })
      avisar('A cópia completa está pronta. Toque em Salvar arquivo e escolha onde guardar.')
    })
  }
  const reserva = dados?.restauracao?.fase === 'escolher' ? dados.restauracao : undefined
  return <main className="tela [overflow-wrap:anywhere]">
    <Topo titulo="Cópia das anotações" aoVoltar={aoVoltar} />
    <p>Guarde suas fichinhas, produtos, fotos e anotações em um arquivo, incluindo o que ainda não foi enviado para sua conta.</p>
    <p>O arquivo contém nomes, telefones e valores. Guarde em um lugar que só você e quem ajuda você possam abrir.</p>
    {leitura.estado === 'falhou' && <p role="alert">Não deu para abrir as preparações. Suas anotações continuam aqui.</p>}
    {aviso && <p role="status">{aviso}</p>}
    {trabalhando && <p role="status">Conferindo as anotações e as fotos…</p>}
    <section aria-label="Guardar uma cópia" className="my-6">
      <h2 className="text-xl">Guardar uma cópia</h2>
      <Botao tipo="principal" desabilitado={trabalhando || !!reserva} aoTocar={() => void preparar()}>Preparar cópia completa</Botao>
      {!dados?.vinculo && <Botao tipo="secundario" desabilitado={trabalhando} aoTocar={aoEntrar}>Entrar na minha conta</Botao>}
      {download && <a className="my-4 flex min-h-11 items-center justify-center rounded-xl bg-acento px-4 py-3 font-semibold text-acento-tinta" href={download.url} download={download.nome}>Salvar arquivo</a>}
      {dados?.estagios.filter((e) => e.tipo === 'exportacao').map((e) => <div key={e.id} className="my-4 border-t border-borda pt-3">
        <p>Cópia de {new Date(e.capturadoEm).toLocaleString('pt-BR')}</p>
        <Botao tipo="secundario" desabilitado={trabalhando} aoTocar={() => void preparar(e.id)}>{e.pronto ? 'Abrir arquivo para salvar' : 'Continuar esta cópia'}</Botao>
        <Botao tipo="secundario" desabilitado={trabalhando} aoTocar={() => void executar(async () => { await copia.descartar(e.id); oferecer(undefined) })}>Descartar só esta preparação</Botao>
      </div>)}
    </section>
    <section aria-label="Usar uma cópia" className="my-6 border-t border-borda pt-4">
      <h2 className="text-xl">Usar uma cópia neste aparelho</h2>
      <p>Use em um aparelho sem anotações, entrando na mesma conta em que o arquivo foi criado. O arquivo inteiro será conferido antes de colocar as anotações aqui.</p>
      {!dados?.restauracao && <Botao tipo="secundario" desabilitado={trabalhando} aoTocar={() => void executar(async () => { await copia.reservarImportacao() })}>Começar a usar uma cópia</Botao>}
      {reserva && <>
        {!dados?.vinculo && <Botao tipo="principal" desabilitado={trabalhando} aoTocar={aoEntrar}>Entrar para usar a cópia</Botao>}
        {dados?.vinculo && <>
          <label className="block my-3">Escolher arquivo da cópia
            <input className={CLASSES_DE_CAMPO} type="file" accept=".zip,application/zip" disabled={trabalhando} onChange={(e) => escolher(e.target.files?.[0])} />
          </label>
          <Botao tipo="principal" desabilitado={trabalhando || !arquivo} aoTocar={() => void executar(async () => {
            if (!arquivo) return
            await copia.importar(arquivo, reserva.id); escolher(undefined)
            avisar('As anotações da cópia estão neste aparelho. Vamos conferir o que já está guardado na sua conta antes de enviar.')
          })}>Conferir e usar esta cópia</Botao>
          {dados.estagios.some((e) => e.id === reserva.id && e.pronto) && <Botao tipo="secundario" desabilitado={trabalhando} aoTocar={() => void executar(async () => {
            await copia.retomarImportacao(reserva.id); avisar('As anotações da cópia estão neste aparelho.')
          })}>Continuar a cópia já conferida</Botao>}
        </>}
        <Botao tipo="secundario" desabilitado={trabalhando} aoTocar={() => void executar(async () => { await copia.descartar(reserva.id); escolher(undefined) })}>Cancelar esta preparação</Botao>
      </>}
      {dados?.restauracao && !reserva && <p role="status">As anotações da cópia estão aqui. A conferência com sua conta e a proteção das fotos continuam quando houver internet.</p>}
    </section>
    {!!dados?.evidencias.length && <section aria-label="Anotações da cópia para conferir">
      <h2 className="text-xl">Anotações da cópia para conferir</h2>
      <p>Para estas anotações, os valores usam o que já estava guardado na conta. O que veio no arquivo continua abaixo para conferir.</p>
      {dados.evidencias.map((e) => <div key={e.id} className="my-4 border-t border-borda py-3">
        <p className="font-semibold">{dados.clientes.find((c) => c.id === e.aceita.clienteId)?.nome}</p>
        <p>No arquivo: {resumo(e.tentativa)}</p><p>Guardado na conta: {resumo(e.aceita)}</p>
      </div>)}
    </section>}
  </main>
}
