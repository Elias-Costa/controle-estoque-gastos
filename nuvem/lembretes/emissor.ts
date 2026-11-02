import { avaliarLembretes, calendarioLembretes, haLembretes, registrarRodadaLembretes, type ObservacaoLembretes } from '../../src/dominio/lembretes.ts'
import { clienteDaNuvem, lancamentoDaNuvem } from '../../src/sincronizacao/borda.ts'
import { movimentoDaNuvem, produtoDaNuvem } from '../../src/sincronizacao/borda-estoque.ts'
import { grupoCaixaDaNuvem } from '../../src/sincronizacao/borda-caixa.ts'
import { inscricaoPushValida, type InscricaoPush } from '../../src/dados/tipos-lembretes.ts'

/** Resultado do transporte, separado da exibição real no aparelho (D-079). */
export type ResultadoPush = { readonly estado: 'aceito' | 'invalida' | 'retentavel' | 'incerto' | 'problema'; readonly retentarApos?: string }
/** Portas do emissor; RPC real e transporte Web Push são verificados em provas próprias. */
export type PortasEmissor = {
  readonly hashToken: string
  readonly agora: () => string
  readonly preparar?: () => Promise<void>
  readonly rpc: (nome: string, argumentos: Record<string, unknown>) => Promise<unknown>
  readonly enviar: (inscricao: InscricaoPush, mensagem: string, validade: number, topico: string) => Promise<ResultadoPush>
}
/** Diagnóstico restrito ao status HTTP; nunca conserva corpo, header ou credencial da RPC. */
export class ErroRpcEmissor extends Error {
  readonly status: number
  constructor(status: number) { super('RPC de lembretes indisponível'); this.status = status }
}

/** Diagnóstico fechado de configuração; nunca recebe valor privado ou exceção de biblioteca. */
export class ErroConfiguracaoEmissor extends Error {
  readonly etapa: 'chaves_ausentes' | 'json_chaves' | 'formato_chaves' | 'importacao_chaves' | 'servidor_push'
  constructor(etapa: ErroConfiguracaoEmissor['etapa']) { super('Configuração do emissor indisponível'); this.etapa = etapa }
}
function objeto(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('Documento inválido')
  return { ...v }
}
function lista(v: unknown): unknown[] { if (!Array.isArray(v)) throw new Error('Lista inválida'); return v }
function texto(v: unknown): string { if (typeof v !== 'string') throw new Error('Texto inválido'); return v }
function ids(v: unknown): string[] { return lista(v).map(texto) }
function observacao(v: unknown): ObservacaoLembretes {
  const o = objeto(v)
  return { baixos: ids(o['baixos']), pendentes: ids(o['pendentes']), lembrados: ids(o['lembrados']),
    ...(o['diaLembrado'] === undefined ? {} : { diaLembrado: texto(o['diaLembrado']) }) }
}

/** Fotografia aceita com codecs existentes: dinheiro continua texto → bigint, nunca number. */
export function lerFotografiaLembretes(v: unknown) {
  const foto = objeto(v), f = objeto(foto['fontes'])
  const fontes = { clientes: lista(f['clientes']).map(clienteDaNuvem), lancamentos: lista(f['lancamentos']).map(lancamentoDaNuvem),
    produtos: lista(f['produtos']).map(produtoDaNuvem), movimentos: [...lista(f['movimentos']),
      ...lista(f['evidencias']).flatMap(lista)].map(movimentoDaNuvem), fatosCaixa: lista(f['caixa']).flatMap((g) => grupoCaixaDaNuvem(g).fatos) }
  const carimbo = texto(foto['carimbo'])
  if (!/^[a-f0-9]{32}$/.test(carimbo)) throw new Error('Carimbo inválido')
  return { fontes, carimbo, observacao: observacao(foto['observacao']) }
}

/** Não inclui conteúdo de resposta, endpoint ou credenciais em mensagens de erro/log. */
export function criarRpcEmissor(url: string, chave: string, transporte: typeof fetch = fetch): PortasEmissor['rpc'] {
  return async (nome, argumentos) => {
    const resposta = await transporte(`${url}/rest/v1/rpc/${nome}`, { method: 'POST', redirect: 'error',
      headers: { apikey: chave, authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
      body: JSON.stringify(argumentos), signal: AbortSignal.timeout(15_000) })
    if (!resposta.ok) throw new ErroRpcEmissor(resposta.status)
    return resposta.status === 204 ? null : resposta.json()
  }
}

/** Autentica antes do banco e limita corpo; falha incerta nunca ganha reenvio automático. */
export function criarHandlerLembretes(portas: PortasEmissor): (pedido: Request) => Promise<Response> {
  return async (pedido) => {
    const token = pedido.headers.get('authorization') ?? ''
    if (!/^[a-f0-9]{64}$/.test(portas.hashToken) || !/^Bearer [a-f0-9]{64}$/.test(token)) return Response.json({ erro: 'nao_autorizado' }, { status: 401 })
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.slice(7)))),
      (b) => b.toString(16).padStart(2, '0')).join('')
    let diferenca = 0
    for (let i = 0; i < 64; i++) diferenca |= hash.charCodeAt(i) ^ portas.hashToken.charCodeAt(i)
    if (diferenca !== 0) return Response.json({ erro: 'nao_autorizado' }, { status: 401 })
    if (pedido.method !== 'POST') return Response.json({ erro: 'metodo_invalido' }, { status: 405 })
    const leitor = pedido.body?.getReader()
    let conteudo = '', tamanho = 0
    if (leitor) {
      for (;;) {
        const parte = await leitor.read(); if (parte.done) break
        tamanho += parte.value.byteLength
        if (tamanho > 128) { await leitor.cancel(); return Response.json({ erro: 'corpo_grande' }, { status: 413 }) }
        conteudo += new TextDecoder().decode(parte.value)
      }
    }
    let verificar = false
    try {
      const corpo = JSON.stringify(JSON.parse(conteudo))
      verificar = corpo === '{"verificar":true}'
      if (corpo !== '{}' && !verificar) throw new Error()
    }
    catch { return Response.json({ erro: 'corpo_invalido' }, { status: 400 }) }
    if (verificar) {
      try { await portas.preparar?.() }
      catch (erro) { return Response.json({ erro: 'configuracao_do_emissor', ...(erro instanceof ErroConfiguracaoEmissor ? { etapa: erro.etapa } : {}) }, { status: 503 }) }
      try { await portas.rpc('listar_contas_lembretes', {}); return Response.json({ pronto: true }) }
      catch (erro) { return Response.json({ erro: 'acesso_ao_banco', ...(erro instanceof ErroRpcEmissor ? { statusBanco: erro.status } : {}) }, { status: 503 }) }
    }
    const instante = portas.agora(), calendario = calendarioLembretes(instante)
    if (calendario.oportunidade === null) return Response.json({ estado: 'fora_do_horario' })
    let aceitos = 0, incertos = 0, falhas = 0
    try {
      await portas.preparar?.()
      for (const conta of ids(await portas.rpc('listar_contas_lembretes', {}))) {
        try {
          const foto = lerFotografiaLembretes(await portas.rpc('fotografia_lembretes', { conta }))
          const avaliado = avaliarLembretes(foto.fontes, foto.observacao, instante)
          const rodada = objeto(await portas.rpc('preparar_rodada_lembretes', { conta, carimbo: foto.carimbo,
            observacao: avaliado.observacao, tem_motivo: haLembretes(avaliado.motivos), agora: instante,
            observacao_rodada: registrarRodadaLembretes(avaliado.observacao, avaliado.motivos) }))
          for (const valor of lista(rodada['destinos'])) {
            const destino = objeto(valor), inscricao = destino['inscricao']
            if (!inscricaoPushValida(inscricao) || typeof destino['revisao'] !== 'number' || !Number.isSafeInteger(destino['revisao']) ||
              typeof destino['tentativa'] !== 'number' || !Number.isInteger(destino['tentativa'])) throw new Error('Destino inválido')
            const aparelho = texto(destino['aparelhoId'])
            const topico = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${conta}/${calendario.dia}`))),
              (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
            let resultado: ResultadoPush
            // O banco já marcou o início. Qualquer queda daqui em diante é ambígua.
            const validade = Math.floor((Date.parse(calendario.venceEm) - Date.parse(portas.agora())) / 1000)
            try { resultado = validade <= 0 ? { estado: 'problema' } : await portas.enviar(inscricao,
              JSON.stringify({ formato: 1, dia: calendario.dia, rodada: topico }), validade, topico) }
            catch { resultado = { estado: 'incerto' } }
            await portas.rpc('concluir_envio_lembretes', { conta, dia: calendario.dia, aparelho, revisao: destino['revisao'],
              tentativa: destino['tentativa'], resultado: resultado.estado, retentar_apos: resultado.retentarApos ?? null })
            if (resultado.estado === 'aceito') aceitos++
            else if (resultado.estado === 'incerto') incertos++
            else falhas++
          }
        } catch { falhas++ }
      }
      return Response.json({ aceitos, incertos, falhas }, { status: falhas ? 503 : 200 })
    } catch { return Response.json({ erro: 'indisponivel' }, { status: 503 }) }
  }
}
