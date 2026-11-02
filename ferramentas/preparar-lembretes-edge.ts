/** Empacota domínio/codecs para o painel/Edge local, sem ler configuração ou credenciais. */
const resultado = await Bun.build({ entrypoints: ['nuvem/lembretes/entrada-edge.js'], outdir: 'dist/lembretes',
  naming: 'index.js', target: 'browser', minify: false, external: ['jsr:@negrel/webpush@0.5.0'] })
if (!resultado.success) throw new Error('Falha ao empacotar o emissor de lembretes')
console.log('Emissor preparado em dist/lembretes/index.js; nenhum segredo incluído.')
