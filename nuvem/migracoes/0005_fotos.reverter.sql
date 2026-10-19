-- Só testes (D-041/050). Não é recuperação de produção com fotos em uso.
-- Conserva bucket privado e arquivos físicos: SQL não apaga bytes no Storage.
-- Descarta o registro de publicação/proteções; clientes, produtos e financeiro ficam intactos.
drop policy fotos_objetos_inserir on storage.objects;
drop policy fotos_objetos_ler on storage.objects;
drop policy fotos_objetos_apagar on storage.objects;
drop trigger produtos_foto_intencao on public.produtos;
drop function public.registrar_foto_fila(jsonb,uuid,uuid);
drop function public.confirmar_arquivo_foto(uuid,text,uuid);
drop function public.buscar_produtos_fotos(uuid,uuid,timestamptz,integer,integer);
drop function public.listar_protecoes_fotos(uuid);
drop function public.liberar_protecao_foto(uuid,uuid,uuid);
drop function public.autorizar_coleta_fotos(integer);
drop function public.confirmar_coleta_foto(uuid);
drop function public.permitir_objeto_foto(text,text);
drop schema fotos_interno cascade;
