import type { GrupoCaixa } from '../dados/tipos-caixa.ts'
import type { FatoCaixa, ReferenciaFatoCaixa } from '../dominio/gastos.ts'
import { diaValido } from '../dominio/regras-estoque.ts'

/** JSON das RPCs próprias de caixa; dinheiro atravessa somente como texto (RI-01). */
export type DocumentoCaixa = Readonly<Record<string, unknown>>
/** Grupo completo na ordem de commit da conta, independente dos cursores F1/F2. */
export type RecepcaoCaixa = { readonly recepcao: string; readonly grupo: GrupoCaixa }

function erro(campo: string): never { throw new Error(`Caixa da nuvem malformado: ${campo}`) }
function objeto(v: unknown, campos: readonly string[]): DocumentoCaixa {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).some((k) => !campos.includes(k))) return erro('campos')
  return { ...v }
}
function texto(v: unknown): string { return typeof v === 'string' ? v : erro('texto') }
function id(v: unknown): string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : erro('id')
}
function revisao(v: unknown): number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : erro('revisão') }
function ref(v: unknown): ReferenciaFatoCaixa {
  const r = objeto(v, ['id', 'revisao'])
  return { id: id(r['id']), revisao: revisao(r['revisao']) }
}
function lista<T>(v: unknown, ler: (v: unknown) => T): T[] { return Array.isArray(v) ? v.map(ler) : erro('lista') }
function contador(v: unknown): string {
  return typeof v === 'string' && /^[1-9]\d*$/.test(v) && BigInt(v) <= 9223372036854775807n ? v : erro('inteiro textual')
}
function fato(v: unknown): FatoCaixa {
  const f = objeto(v, ['id', 'revisao', 'tipo', 'data', 'valor', 'categoria', 'classificacao', 'mercadoria', 'alvo'])
  const data = texto(f['data'])
  if (!diaValido(data) || data.startsWith('0000') || new Date(`${data}T00:00:00.000Z`).toISOString().slice(0, 10) !== data) return erro('data')
  const base = { ...ref({ id: f['id'], revisao: f['revisao'] }), data }
  if (f['tipo'] === 'estorno') {
    objeto(v, ['id', 'revisao', 'tipo', 'data', 'alvo'])
    return { ...base, tipo: 'estorno', alvo: ref(f['alvo']) }
  }
  const categoria = texto(f['categoria']), classificacao = f['classificacao']
  if (!categoria.trim() || (classificacao !== 'negocio' && classificacao !== 'pessoal')) return erro('classificação/categoria')
  const movimento = { ...base, valor: BigInt(contador(f['valor'])), categoria, classificacao }
  if (f['tipo'] === 'despesa') {
    objeto(v, ['id', 'revisao', 'tipo', 'data', 'valor', 'categoria', 'classificacao', 'mercadoria'])
    if (typeof f['mercadoria'] !== 'boolean' || (f['mercadoria'] && classificacao !== 'negocio')) return erro('mercadoria')
    return { ...movimento, classificacao, tipo: 'despesa', mercadoria: f['mercadoria'] }
  }
  if (f['tipo'] === 'receita-avulsa') {
    objeto(v, ['id', 'revisao', 'tipo', 'data', 'valor', 'categoria', 'classificacao'])
    return { ...movimento, classificacao, tipo: 'receita-avulsa' }
  }
  return erro('tipo de fato')
}

/** Confere todos os campos e o manifesto sem publicar uma metade da correção (D-069). */
export function grupoCaixaDaNuvem(v: unknown): GrupoCaixa {
  const g = objeto(v, ['operacao', 'fatos']), o = objeto(g['operacao'], ['id', 'revisao', 'formato', 'tipo', 'alvo', 'fatos'])
  const tipo = o['tipo']
  if (o['formato'] !== 1 || (tipo !== 'registro' && tipo !== 'estorno' && tipo !== 'correcao')) return erro('formato/tipo')
  const operacao = { ...ref({ id: o['id'], revisao: o['revisao'] }), formato: 1 as const, tipo,
    fatos: lista(o['fatos'], ref), ...(o['alvo'] === undefined ? {} : { alvo: ref(o['alvo']) }) }
  const fatos = lista(g['fatos'], fato), estornos = fatos.filter((f) => f.tipo === 'estorno')
  if (new Set(fatos.map((f) => f.id)).size !== fatos.length || fatos.some((f) => f.id === operacao.id) ||
    operacao.fatos.length !== fatos.length || operacao.fatos.some((r, i) => r.id !== fatos[i]?.id || r.revisao !== fatos[i]?.revisao) ||
    (tipo === 'registro' ? fatos.length !== 1 || estornos.length !== 0 || !!operacao.alvo
      : fatos.length !== (tipo === 'correcao' ? 2 : 1) || estornos.length !== 1 || !operacao.alvo ||
        estornos.some((f) => f.alvo.id !== operacao.alvo?.id || f.alvo.revisao !== operacao.alvo?.revisao) ||
        fatos.some((f) => f.id === operacao.alvo?.id))) return erro('grupo incompleto ou divergente')
  return { operacao: { ...operacao, tipo }, fatos }
}

/** Serialização integral, sem metadados locais nem conversão monetária para number. */
export function grupoCaixaParaNuvem(grupo: GrupoCaixa): DocumentoCaixa {
  const documento: unknown = JSON.parse(JSON.stringify(grupo, (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v))
  grupoCaixaDaNuvem(documento)
  return objeto(documento, ['operacao', 'fatos'])
}

/** Contador textual positivo e grupo indivisível; forma incorreta lança antes do cursor. */
export function recepcaoCaixaDaNuvem(v: unknown): RecepcaoCaixa {
  const r = objeto(v, ['recepcao', 'grupo'])
  return { recepcao: contador(r['recepcao']), grupo: grupoCaixaDaNuvem(r['grupo']) }
}
