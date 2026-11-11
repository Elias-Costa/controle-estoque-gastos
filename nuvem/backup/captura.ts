import { createHash } from 'node:crypto'
import { dadosDaCopia, exigirCopia, objetoCopia, lerVinculoCopia } from '../../src/dados/formato-copia.ts'
import { LIMITES_COPIA, type DadosCopia, type VinculoConta } from '../../src/dados/tipos-copia.ts'
import { clienteDaNuvem, lancamentoDaNuvem, normalizarCarimbo } from '../../src/sincronizacao/borda.ts'
import { categoriaDaNuvem, produtoDaNuvem, recepcaoDaNuvem } from '../../src/sincronizacao/borda-estoque.ts'
import { recepcaoCaixaDaNuvem } from '../../src/sincronizacao/borda-caixa.ts'
import { modelosDaNuvem } from '../../src/sincronizacao/borda-modelos.ts'
import { identidadeDaNuvem } from '../../src/sincronizacao/identidade-loja.ts'
import { efeitosAposEncerramentos, identidadeDaTentativa } from '../../src/dominio/recuperacao-estoque.ts'
import { chaveDoEfeito } from '../../src/dominio/estoque.ts'
import { conteudoDoEfeito } from '../../src/dominio/regras-estoque.ts'
import { criarArquivoBackup, type EtapaArquivoCopia } from '../../src/plataforma/arquivo-copia.ts'
import { indexarMaterialBackup } from '../../src/plataforma/material-backup.ts'

/** Cabeçalho durável; conta/destino não são credenciais Google. */
export type CapturaServidor = { readonly id: string; readonly capturadoEm: string; readonly dia: string; readonly vinculo: VinculoConta }
/** Portas próprias do servidor; nunca aceitar nome de RPC ou caminho arbitrário vindo do app. */
export type RpcBackup = (nome: string, argumentos: Readonly<Record<string, unknown>>) => Promise<unknown>
/** Fontes fechadas da fotografia SQL; nenhuma tabela Auth/push/configuração é exportada. */
export const FONTES_BACKUP = ['clientes', 'lancamentos', 'categorias', 'produtos', 'estoque', 'caixa', 'modelos', 'identidades', 'fotos'] as const
/** Conjunto ainda não decodificado; monetários já chegam em texto exato do Postgres. */
export type FontesBackup = Record<typeof FONTES_BACKUP[number], readonly unknown[]>

/** Valida a resposta antes de carregar lotes, recusando conta/destino diferentes. */
export function lerCapturaServidor(v: unknown, esperado: VinculoConta): CapturaServidor {
  exigirCopia(objetoCopia(v) && typeof v['id'] === 'string' && /^[0-9a-f-]{36}$/.test(v['id']) && typeof v['dia'] === 'string')
  const vinculo = lerVinculoCopia(v['vinculo'])
  exigirCopia(vinculo.contaId === esperado.contaId && vinculo.destino === esperado.destino, 'conta')
  return { id: v['id'], dia: v['dia'], capturadoEm: normalizarCarimbo('backup.capturadoEm', v['capturadoEm']), vinculo }
}

/** Só lê o documento já retido, sem páginas de tabelas vivas ou tolerância a lote faltante. */
export async function carregarFontesBackup(rpc: RpcBackup, captura: CapturaServidor): Promise<FontesBackup> {
  const fontes: FontesBackup = { clientes: [], lancamentos: [], categorias: [], produtos: [], estoque: [], caixa: [], modelos: [], identidades: [], fotos: [] }
  let quantidade = 0, bytes = 0
  for (const tabela of FONTES_BACKUP) {
    const linhas: unknown[] = []
    let total: number | undefined
    do {
      const pagina = await rpc('ler_captura_backup', { conta: captura.vinculo.contaId, captura: captura.id, tabela, inicio: linhas.length, limite: 250 })
      exigirCopia(objetoCopia(pagina) && Array.isArray(pagina['linhas']) && typeof pagina['total'] === 'number' && Number.isSafeInteger(pagina['total']) && pagina['total'] >= 0)
      exigirCopia(total === undefined || total === pagina['total'])
      total = pagina['total']
      exigirCopia(pagina['linhas'].length <= 250 && linhas.length + pagina['linhas'].length <= total && (pagina['linhas'].length > 0 || total === 0))
      quantidade += pagina['linhas'].length; bytes += new TextEncoder().encode(JSON.stringify(pagina['linhas'])).byteLength
      exigirCopia(quantidade <= LIMITES_COPIA.registros && bytes <= LIMITES_COPIA.textos, 'limite')
      linhas.push(...pagina['linhas'])
    } while (linhas.length < total)
    fontes[tabela] = linhas
  }
  return fontes
}

const LOTE_ORIGINAIS = 8

function sha256(conteudo: string | Uint8Array): string {
  return createHash('sha256').update(conteudo).digest('hex')
}

function idDeVersao(tipo: string, conteudo: string): string {
  const hash = sha256(`${tipo}:${conteudo}`)
  // UUID técnico reconstruído, estável por conteúdo. Nenhum id de cliente/fato/movimento é trocado.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
function registro(v: unknown): Record<string, unknown> { exigirCopia(objetoCopia(v)); return v }

/** Reconstrói o retrato 5/10 e confere referências/tamanhos; SHA dos originais é conferido ao montar o ZIP. */
export async function dadosDaCaptura(c: CapturaServidor, f: FontesBackup,
  baixarOriginal: (referencia: Readonly<Record<string, unknown>>) => Promise<Uint8Array>,
  aoLerOriginais?: () => void): Promise<DadosCopia> {
  const d: DadosCopia = { clientes: f.clientes.map(clienteDaNuvem), lancamentos: f.lancamentos.map((v) => {
    const l = registro(v); return lancamentoDaNuvem({ ...l, cliente_id: l['clienteId'], estorna_id: l['estornaId'] })
  }), categorias: f.categorias.map(categoriaDaNuvem), produtos: f.produtos.map(produtoDaNuvem), fila: [], sincronizacao: [],
    operacoes: [], movimentos: [], versoesEstoque: [], encerramentos: [], relogioEstoque: [], fotos: [], protecoesFotos: [],
    enviosProdutoFoto: [], usosFotos: [], estadoFotos: [], fatosCaixa: [], operacoesCaixa: [], versoesCaixa: [], evidenciasCopia: [],
    modelos: f.modelos.map((v) => modelosDaNuvem(registro(v))), identidadesLoja: f.identidades.map((v) => identidadeDaNuvem(registro(v))) }
  const recepcoes = f.estoque.map(recepcaoDaNuvem), operacoes = recepcoes.filter((r) => r.tipo === 'operacao')
  d.encerramentos = recepcoes.flatMap((r) => r.tipo === 'encerramento' ? [r.encerramento] : [])
  const aceitos = operacoes.map((r) => r.grupo)
  const projecao = efeitosAposEncerramentos({ operacoes: aceitos, lancamentos: d.lancamentos,
    movimentos: operacoes.flatMap((r) => r.grupo.movimentos) }, [],
  d.encerramentos.map((e) => ({ ...e, tentativa: identidadeDaTentativa(e.evidencia.grupo) })))
  const gruposAceitos = new Map(aceitos.map((g) => [conteudoDoEfeito(g), g]))
  const grupos = new Map(gruposAceitos)
  for (const e of d.encerramentos) {
    grupos.set(conteudoDoEfeito(e.evidencia.grupo), e.evidencia.grupo)
    if (e.novaOperacao) grupos.set(conteudoDoEfeito(e.novaOperacao), e.novaOperacao)
  }
  // A mesma chave canônica conserva os ids da captura ao retomar um ZIP já reservado.
  const versoes = new Map<string, string>()
  for (const [conteudo, grupo] of grupos) {
    const id = idDeVersao('estoque', conteudo)
    versoes.set(conteudo, id)
    d.versoesEstoque.push({ id, operacaoId: grupo.operacao.id, grupo, ...(gruposAceitos.has(conteudo) ? { aceita: true } : {}) })
  }
  const atuais = new Map([...aceitos, ...projecao.pendentes].map((g) => [g.operacao.id, g]))
  for (const grupo of atuais.values()) {
    const versaoId = versoes.get(conteudoDoEfeito(grupo)); exigirCopia(versaoId)
    d.operacoes.push({ ...grupo.operacao, versaoId })
  }
  for (const grupo of projecao.pendentes) d.fila.push({ ordem: d.fila.length + 1, tabela: 'operacoes', registroId: grupo.operacao.id,
    versao: grupo.operacao.revisao, criadoEm: c.capturadoEm })
  d.lancamentos = [...projecao.lancamentos]
  const movimentos = new Map([...operacoes.flatMap((r) => r.evidencias), ...projecao.movimentos].map((m) => [chaveDoEfeito(m), m]))
  d.movimentos = [...movimentos.values()]
  d.relogioEstoque = [{ chave: 'cadastro', ultimo: d.movimentos.reduce((maior, m) => m.tipo === 'compra' && m.ordemCadastro > maior ? m.ordemCadastro : maior, 0n) }]
  for (const r of f.caixa.map(recepcaoCaixaDaNuvem)) {
    const id = idDeVersao('caixa', conteudoDoEfeito(r.grupo))
    d.versoesCaixa.push({ id, operacaoId: r.grupo.operacao.id, grupo: r.grupo, aceita: true })
    d.operacoesCaixa.push({ ...r.grupo.operacao, versaoId: id }); d.fatosCaixa.push(...r.grupo.fatos)
  }
  aoLerOriginais?.()
  async function lerOriginal(entrada: unknown): Promise<DadosCopia['fotos'][number]> {
    const r = registro(entrada)
    exigirCopia(r['disponivel'] === true && typeof r['fotoId'] === 'string' && typeof r['copiaId'] === 'string' &&
      typeof r['produtoId'] === 'string' && typeof r['caminho'] === 'string' && typeof r['sha256'] === 'string' &&
      typeof r['bytes'] === 'number' && typeof r['largura'] === 'number' && typeof r['altura'] === 'number', 'foto')
    exigirCopia(r['caminho'] === `${c.vinculo.contaId}/${r['fotoId']}/${r['copiaId']}.jpeg`, 'foto')
    const binario = await baixarOriginal(r)
    exigirCopia(binario.byteLength === r['bytes'], 'foto')
    return { id: r['fotoId'], copiaId: r['copiaId'], produtoId: r['produtoId'], cadastroEm: normalizarCarimbo('foto.cadastro', r['cadastroEm']),
      geracaoEnvio: c.id, sha256: r['sha256'], bytes: r['bytes'], largura: r['largura'], altura: r['altura'], caminho: r['caminho'],
      situacao: 'disponivel', registrada: true, binario }
  }
  // Limita as requisições simultâneas e conserva a ordem da captura, mesmo se o Storage responder fora de ordem.
  for (let inicio = 0; inicio < f.fotos.length; inicio += LOTE_ORIGINAIS) {
    const lote = await Promise.allSettled(f.fotos.slice(inicio, inicio + LOTE_ORIGINAIS).map(lerOriginal))
    for (const original of lote) {
      if (original.status === 'rejected') throw original.reason
      d.fotos.push(original.value)
    }
  }
  return dadosDaCopia(d, 5)
}

/** Material canônico por fato/grupo, usado somente para conferir cobertura na retenção D-084. */
export async function materialDaCaptura(d: DadosCopia): Promise<readonly string[]> {
  return (await indexarMaterialBackup(d, sha256)).material
}

/** Confere os bytes efetivos e empacota a captura; miniaturas são reconstruídas na importação. */
export async function pacoteDaCaptura(c: CapturaServidor, dados: DadosCopia, aoAvancar?: (etapa: EtapaArquivoCopia) => void): Promise<Blob> {
  return criarArquivoBackup({ id: c.id, tipo: 'exportacao', vinculo: c.vinculo, capturadoEm: c.capturadoEm, pronto: true }, dados,
    { tipo: 'servidor' }, aoAvancar, async (blob) => sha256(new Uint8Array(await blob.arrayBuffer())))
}
