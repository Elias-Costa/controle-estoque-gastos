import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../src/dados/repositorio-copia.ts'
import { lerDadosCopia, exigirCopia } from '../src/dados/formato-copia.ts'
import { lerArquivoCopia } from '../src/plataforma/arquivo-copia.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { conteudoDoEfeito } from '../src/dominio/regras-estoque.ts'
import { TABELAS_COPIA, type OrigemBackup, type VinculoConta } from '../src/dados/tipos-copia.ts'

declare global { interface Window { restaurarBackupDeTeste: (vinculo: VinculoConta, origem: OrigemBackup['tipo']) => Promise<Record<string, unknown>> } }

// Instrumento em origem de loopback efêmera; não entra no app nem usa credenciais.
window.restaurarBackupDeTeste = async (vinculo, origem) => {
  const arquivo = await (await fetch('/copia.zip')).blob()
  const lido = await lerArquivoCopia(arquivo, vinculo)
  exigirCopia(lido.origem?.tipo === origem)
  const nome = `ensaio-backup-${crypto.randomUUID()}`, banco = new BancoLocal(nome)
  await vincularContaCopia(banco, vinculo)
  const repo = criarRepositorioCopia(banco), reserva = await repo.reservarImportacao()
  await repo.prepararImportacao(reserva, vinculo, lido.capturadoEm, lido.dados)
  await repo.publicar(reserva, vinculo)
  banco.close()
  const reaberto = new BancoLocal(nome)
  try {
    const dados = await reaberto.transaction('r', reaberto.tables, () => lerDadosCopia(reaberto))
    const ordenar = (linhas: readonly unknown[]) => linhas.map(conteudoDoEfeito).sort()
    const iguais = ['clientes', 'lancamentos', 'categorias', 'produtos', 'operacoes', 'movimentos', 'encerramentos',
      'fatosCaixa', 'operacoesCaixa', 'modelos', 'identidadesLoja', 'fila', 'evidenciasCopia'] as const
    for (const t of iguais) exigirCopia(conteudoDoEfeito(ordenar(dados[t])) === conteudoDoEfeito(ordenar(lido.dados[t])))
    for (const foto of lido.dados.fotos) {
      const restaurada = dados.fotos.find((f) => f.id === foto.id)
      exigirCopia(foto.binario && restaurada?.binario && restaurada.miniatura)
      exigirCopia(await hashDaFoto(foto.binario) === await hashDaFoto(restaurada.binario))
      exigirCopia(restaurada.miniatura.byteLength > 0 && restaurada.miniatura.byteLength <= 20480)
    }
    return { importado: true, reaberto: true, miniaturasNativas: true, origem: lido.origem,
      quantidades: Object.fromEntries(TABELAS_COPIA.map((t) => [t, dados[t].length])) }
  } finally { reaberto.close() }
}
