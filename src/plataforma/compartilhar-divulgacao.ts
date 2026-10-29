/** Consulta o arquivo efetivo, sem presumir suporte a PDF a partir de texto ou de outro navegador. */
export function podeCompartilharDivulgacao(arquivo: File): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [arquivo] })
}

/** Chamada no gesto após o preparo; retorno não é confirmação de envio/entrega (D-007/074). */
export async function compartilharDivulgacao(arquivo: File): Promise<'retornou' | 'cancelou'> {
  try { await navigator.share({ files: [arquivo] }); return 'retornou' }
  catch (erro) { if (erro instanceof DOMException && erro.name === 'AbortError') return 'cancelou'; throw erro }
}
