import { bancoLocal } from './banco-local'
import { uuidv7 } from './identidade'
import { nuvem, TABELA_SONDA } from './nuvem'

/**
 * As verificações de E-00.
 *
 * Cada uma existe porque uma decisão registrada depende dela. Nenhuma é
 * decorativa, e nenhuma pode ser contornada pelo agente: falha aqui é decisão
 * reaberta (AGENTS.md §6), não desvio criativo.
 */

export type Situacao = 'ok' | 'falhou' | 'indisponivel'

export interface Resultado {
  id: string
  titulo: string
  /** Qual decisão ou falha eliminatória depende desta verificação. */
  origem: string
  situacao: Situacao
  detalhe: string
}

/**
 * A verificação nova de hoje: `bigint` sobrevive ao IndexedDB do WebKit? (D-022)
 *
 * O valor escolhido é 2^53 + 1 — o menor inteiro que `number` NÃO consegue
 * representar. Se em algum ponto do caminho o valor for convertido para número
 * de ponto flutuante, ele volta como 2^53 e o teste acusa. Um valor pequeno
 * passaria mesmo com a conversão acontecendo, e não provaria nada.
 */
async function verificarBigIntLocal(): Promise<Resultado> {
  const base = {
    id: 'bigint-indexeddb',
    titulo: 'bigint sobrevive ao IndexedDB',
    origem: 'D-022 · EL-03',
  }
  const valorOriginal = 9007199254740993n // 2^53 + 1
  const id = uuidv7()

  try {
    await bancoLocal.sondas.put({
      id,
      rotulo: 'sonda de precisão',
      valorCentavos: valorOriginal,
      criadoEm: new Date().toISOString(),
    })
    const lido = await bancoLocal.sondas.get(id)
    await bancoLocal.sondas.delete(id)

    if (!lido) {
      return { ...base, situacao: 'falhou', detalhe: 'o registro não voltou da base' }
    }
    const tipo = typeof lido.valorCentavos
    if (tipo !== 'bigint') {
      return {
        ...base,
        situacao: 'falhou',
        detalhe: `voltou como ${tipo}, não bigint — D-022 reaberta: guardar como string`,
      }
    }
    if (lido.valorCentavos !== valorOriginal) {
      return {
        ...base,
        situacao: 'falhou',
        detalhe: `perdeu precisão: ${lido.valorCentavos} em vez de ${valorOriginal}`,
      }
    }
    return { ...base, situacao: 'ok', detalhe: `${valorOriginal} voltou exato, como bigint` }
  } catch (erro) {
    return { ...base, situacao: 'falhou', detalhe: descreverErro(erro) }
  }
}

/** Persistência concedida pelo navegador (D-020, EL-05). */
async function verificarPersistencia(): Promise<Resultado> {
  const base = {
    id: 'persistencia',
    titulo: 'Armazenamento persistente concedido',
    origem: 'D-020 · EL-05',
  }
  if (!navigator.storage?.persist) {
    return { ...base, situacao: 'indisponivel', detalhe: 'navigator.storage.persist não existe' }
  }
  try {
    const jaPersistido = await navigator.storage.persisted()
    const concedido = jaPersistido || (await navigator.storage.persist())
    const estimativa = await navigator.storage.estimate()
    const cota = estimativa.quota ? `${(estimativa.quota / 1024 / 1024).toFixed(0)} MB de cota` : 'cota desconhecida'
    return {
      ...base,
      situacao: concedido ? 'ok' : 'falhou',
      detalhe: concedido
        ? `concedido · ${cota}`
        : `NEGADO · ${cota} — a base pode ser despejada sem aviso (EL-05)`,
    }
  } catch (erro) {
    return { ...base, situacao: 'falhou', detalhe: descreverErro(erro) }
  }
}

/**
 * Marcador de sobrevivência (RT-13, EL-05).
 *
 * A primeira execução grava. As seguintes dizem há quanto tempo o dado está lá.
 * É a única verificação de E-00 que não se conclui numa sessão: ela só significa
 * alguma coisa depois de o aparelho ser reiniciado e o app reaberto.
 */
async function verificarSobrevivencia(): Promise<Resultado> {
  const base = {
    id: 'sobrevivencia',
    titulo: 'Dado sobrevive a fechar o app e reiniciar',
    origem: 'RT-13 · EL-05',
  }
  try {
    const existente = await bancoLocal.marcadores.get('marcador')
    if (!existente) {
      const escritoEm = new Date().toISOString()
      await bancoLocal.marcadores.put({ id: 'marcador', escritoEm })
      return {
        ...base,
        situacao: 'indisponivel',
        detalhe: 'marcador gravado agora — reinicie o aparelho, reabra e confira aqui',
      }
    }
    const idade = Date.now() - new Date(existente.escritoEm).getTime()
    return {
      ...base,
      situacao: 'ok',
      detalhe: `marcador de ${formatarIdade(idade)} atrás continua na base`,
    }
  } catch (erro) {
    return { ...base, situacao: 'falhou', detalhe: descreverErro(erro) }
  }
}

/** O app está rodando instalado na tela de início? (RF-23) */
function verificarStandalone(): Resultado {
  const base = { id: 'standalone', titulo: 'Rodando instalado, em tela cheia', origem: 'RF-23' }
  const porMedia = window.matchMedia('(display-mode: standalone)').matches
  // O Safari do iOS expõe a bandeira própria, e historicamente antes da media query.
  const porIos = (navigator as Navigator & { standalone?: boolean }).standalone === true
  const instalado = porMedia || porIos
  return {
    ...base,
    situacao: instalado ? 'ok' : 'indisponivel',
    detalhe: instalado
      ? `sim (${porMedia ? 'display-mode' : 'navigator.standalone'})`
      : 'aberto no navegador — adicione à tela de início para verificar',
  }
}

/** Service worker registrado (RF-23, pré-requisito do funcionamento offline). */
async function verificarServiceWorker(): Promise<Resultado> {
  const base = { id: 'service-worker', titulo: 'Service worker registrado', origem: 'RF-23 · EL-06' }
  if (!('serviceWorker' in navigator)) {
    return { ...base, situacao: 'falhou', detalhe: 'a API não existe neste contexto (precisa de HTTPS)' }
  }
  try {
    const registro = await navigator.serviceWorker.getRegistration()
    return registro
      ? { ...base, situacao: 'ok', detalhe: `escopo ${registro.scope}` }
      : { ...base, situacao: 'indisponivel', detalhe: 'ainda não registrado — recarregue a página' }
  } catch (erro) {
    return { ...base, situacao: 'falhou', detalhe: descreverErro(erro) }
  }
}

/** Fila de saída: quantos itens esperam envio (RI-02, EL-01). */
async function verificarFila(): Promise<Resultado> {
  const base = { id: 'fila', titulo: 'Fila de sincronização', origem: 'D-003 · RI-02' }
  try {
    const pendentes = await bancoLocal.fila.where('enviado').equals(0).count()
    const enviados = await bancoLocal.fila.where('enviado').equals(1).count()
    return {
      ...base,
      situacao: 'ok',
      detalhe: `${pendentes} pendente(s), ${enviados} enviado(s) · rede ${navigator.onLine ? 'disponível' : 'ausente'}`,
    }
  } catch (erro) {
    return { ...base, situacao: 'falhou', detalhe: descreverErro(erro) }
  }
}

/** Alcance do backend (D-021). Sem configuração, é indisponível — não é falha. */
async function verificarNuvem(): Promise<Resultado> {
  const base = { id: 'nuvem', titulo: 'Supabase alcançável e gravando', origem: 'D-021 · RNF-08' }
  if (!nuvem) {
    return {
      ...base,
      situacao: 'indisponivel',
      detalhe: 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não configuradas',
    }
  }
  if (!navigator.onLine) {
    return { ...base, situacao: 'indisponivel', detalhe: 'sem rede — esperado em modo avião' }
  }
  try {
    const inicio = performance.now()
    const { error } = await nuvem.from(TABELA_SONDA).select('id').limit(1)
    const ms = (performance.now() - inicio).toFixed(0)
    if (error) {
      return { ...base, situacao: 'falhou', detalhe: `${error.message} (rode o SQL da tabela sonda)` }
    }
    return { ...base, situacao: 'ok', detalhe: `respondeu em ${ms} ms` }
  } catch (erro) {
    return { ...base, situacao: 'falhou', detalhe: descreverErro(erro) }
  }
}

/**
 * Tempo de carregamento da página (RNF-04, parcialmente).
 *
 * ATENÇÃO À LEITURA DESTE NÚMERO: ele começa a contar na navegação, ou seja,
 * *depois* de o iOS ter lançado o web app. O tempo entre o dedo tocar o ícone e
 * a tela aparecer NÃO está aqui e nenhuma API do navegador o enxerga.
 *
 * RNF-04 fala de "abertura a partir do ícone até tela útil", então este número
 * é um piso, não a medida. A medida de RNF-04 é cronômetro na mão, feita com a
 * usuária — como RT-14 e RT-15.
 */
function verificarCarregamento(): Resultado {
  const base = { id: 'carregamento', titulo: 'Tempo de carregamento da página', origem: 'RNF-04 (parcial)' }
  const navegacao = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (!navegacao) {
    return { ...base, situacao: 'indisponivel', detalhe: 'métrica de navegação não disponível' }
  }
  const ms = navegacao.domContentLoadedEventEnd
  const origem = navegacao.transferSize === 0 ? 'do cache' : 'da rede'
  return {
    ...base,
    situacao: ms < 2000 ? 'ok' : 'falhou',
    detalhe: `${ms.toFixed(0)} ms ${origem} · NÃO inclui o tempo de lançamento do app pelo iOS — RNF-04 exige cronômetro`,
  }
}

/** Roda todas as verificações. */
export async function rodarVerificacoes(): Promise<Resultado[]> {
  return [
    await verificarBigIntLocal(),
    await verificarPersistencia(),
    await verificarSobrevivencia(),
    verificarStandalone(),
    await verificarServiceWorker(),
    await verificarFila(),
    await verificarNuvem(),
    verificarCarregamento(),
  ]
}

/** Enfileira uma escrita fictícia, como uma venda offline faria (RI-02, EL-01). */
export async function enfileirarEscrita(): Promise<string> {
  const id = uuidv7()
  await bancoLocal.fila.put({
    id,
    tipo: 'sonda',
    carga: JSON.stringify({ rotulo: 'venda fictícia', valorCentavos: '4703' }),
    criadoEm: new Date().toISOString(),
    enviado: 0,
  })
  return id
}

/**
 * Esvazia a fila contra o Supabase (RI-05, EL-04).
 *
 * O envio é `upsert` pelo id gerado no dispositivo (D-029): mandar o mesmo item
 * duas vezes escreve a mesma linha duas vezes, e não duas linhas.
 *
 * `vezes` reenvia **o mesmo lote**, antes de marcá-lo como enviado. Essa ordem é
 * o ponto todo: a primeira versão desta função chamava o envio duas vezes em
 * sequência, mas como a segunda chamada relia a fila — já sem pendentes — ela
 * mandava zero itens e não provava nada. Reenviar o mesmo lote é o que de fato
 * exercita EL-04.
 */
export async function sincronizar(vezes = 1): Promise<{ enviados: number; erro: string | null }> {
  if (!nuvem) return { enviados: 0, erro: 'Supabase não configurado' }

  const pendentes = await bancoLocal.fila.where('enviado').equals(0).toArray()
  if (pendentes.length === 0) return { enviados: 0, erro: null }

  const linhas = pendentes.map((item) => ({
    id: item.id,
    rotulo: item.tipo,
    valor_centavos: (JSON.parse(item.carga) as { valorCentavos: string }).valorCentavos,
    criado_em: item.criadoEm,
  }))

  for (let tentativa = 0; tentativa < vezes; tentativa++) {
    const { error } = await nuvem.from(TABELA_SONDA).upsert(linhas, { onConflict: 'id' })
    // Falha deixa a fila intacta: nada é marcado como enviado, e o item continua
    // pendente para a próxima tentativa. É o que salvou o teste de 2026-09-05.
    if (error) return { enviados: 0, erro: error.message }
  }

  await bancoLocal.fila.bulkPut(pendentes.map((item) => ({ ...item, enviado: 1 })))
  return { enviados: pendentes.length, erro: null }
}

/**
 * Inspeciona a nuvem contando linhas **e ids distintos** (EL-04).
 *
 * Contar só o total não prova nada: 12 linhas podem ser 12 itens legítimos ou 6
 * itens duplicados, e o teste de 2026-09-05 caiu exatamente nessa ambiguidade.
 * `total > distintos` é duplicação, sem margem para interpretação.
 */
export async function inspecionarNuvem(): Promise<{ total: number; distintos: number } | null> {
  if (!nuvem) return null
  const { data, error } = await nuvem.from(TABELA_SONDA).select('id')
  if (error || !data) return null
  const ids = data.map((linha) => String((linha as { id: unknown }).id))
  return { total: ids.length, distintos: new Set(ids).size }
}

/**
 * Zera o teste: apaga as linhas da tabela sonda e esvazia a fila local.
 *
 * Sem partir do zero, a aritmética de EL-04 depende de lembrar quantas linhas
 * havia antes — e lembrar não é evidência.
 */
export async function zerarTeste(): Promise<string> {
  await bancoLocal.fila.clear()
  if (!nuvem) return 'fila local limpa · Supabase não configurado'
  // PostgREST exige um filtro em DELETE; o uuid zerado nunca existe, então o
  // `neq` alcança todas as linhas sem apagar nada por engano fora desta tabela.
  const { error } = await nuvem
    .from(TABELA_SONDA)
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000')
  return error ? `fila local limpa · erro na nuvem: ${error.message}` : 'teste zerado: fila local e tabela sonda vazias'
}

function descreverErro(erro: unknown): string {
  return erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro)
}

function formatarIdade(ms: number): string {
  const minutos = ms / 60000
  if (minutos < 60) return `${minutos.toFixed(0)} min`
  const horas = minutos / 60
  if (horas < 24) return `${horas.toFixed(1)} h`
  return `${(horas / 24).toFixed(1)} dias`
}
