/** D-077: contato é resposta privada de uma consulta explícita, nunca configuração do build. */
export type ResultadoContatoSuporte = { readonly ok: true; readonly telefone: string }
  | { readonly ok: false; readonly motivo: 'entrar' | 'nao-configurado' | 'falhou' }

/** Borda mínima da RPC; testes de forma não substituem a autorização real no Postgres. */
export type ConsultarContatoSuporte = () => Promise<{ readonly data: unknown; readonly error: { readonly code: string } | null }>

/** Não consulta nem guarda contato ao criar; cada chamada corresponde a um toque em relatar. */
export function criarConsultaContatoSuporte(consultar: ConsultarContatoSuporte | null) {
  return async (): Promise<ResultadoContatoSuporte> => {
    if (consultar === null) return { ok: false, motivo: 'falhou' }
    try {
      const { data, error } = await consultar()
      if (error) return { ok: false, motivo: error.code === '42501' || /^PGRST3\d\d$/.test(error.code) ? 'entrar' : 'falhou' }
      if (data === null) return { ok: false, motivo: 'nao-configurado' }
      if (typeof data !== 'string' || !/^55[0-9]{10,11}$/.test(data)) return { ok: false, motivo: 'falhou' }
      return { ok: true, telefone: data }
    } catch { return { ok: false, motivo: 'falhou' } }
  }
}
