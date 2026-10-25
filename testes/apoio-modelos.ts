import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core.js'
import { exigirCopia, objetoCopia } from '../src/dados/formato-copia.ts'

/** Reconstitui o contrato literal da E-35 sem modelos; não altera dados nem seus hashes. */
export async function pacoteSemModelos(arquivo: Blob, antigo: boolean): Promise<Blob> {
  const leitor = new ZipReader(new BlobReader(arquivo), { useWebWorkers: false })
  const escritor = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false })
  for (const entrada of await leitor.getEntries()) {
    exigirCopia(!entrada.directory)
    if (entrada.filename.startsWith('dados/modelos/')) continue
    let blob = await entrada.getData(new BlobWriter())
    if (entrada.filename === 'manifesto.json') {
      const m: unknown = JSON.parse(await blob.text())
      exigirCopia(objetoCopia(m) && objetoCopia(m['quantidades']) && Array.isArray(m['arquivos']))
      m['arquivos'] = m['arquivos'].filter((a: unknown) => { exigirCopia(objetoCopia(a) && typeof a['nome'] === 'string'); return !a['nome'].startsWith('dados/modelos/') })
      delete m['quantidades']['modelos']
      if (antigo) { m['formato'] = 1; m['esquema'] = 6 }
      blob = new Blob([JSON.stringify(m)])
    }
    await escritor.add(entrada.filename, new BlobReader(blob))
  }
  await leitor.close()
  return escritor.close()
}
