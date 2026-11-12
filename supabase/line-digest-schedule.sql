-- Run only after 011, Edge Function deployment and private secrets are configured.
-- UTC 21,0,3,7,12 = JST 6,9,12,16,21. One recipient, one digest per slot.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists(select 1 from vault.decrypted_secrets where name='line_digest_cron_secret') then
  perform vault.create_secret(encode(gen_random_bytes(32),'hex'),'line_digest_cron_secret','Private LINE digest scheduler authentication');
 end if;
end;$$;
select cron.schedule('line-submission-digest','0 0,3,7,12,21 * * *',$cmd$
 select net.http_post(
  url:='https://ajzqkqbdoyftfxwnsgxh.supabase.co/functions/v1/line-digest',
  headers:=jsonb_build_object('Content-Type','application/json','x-digest-secret',(select decrypted_secret from vault.decrypted_secrets where name='line_digest_cron_secret')),
  body:='{}'::jsonb,timeout_milliseconds:=30000
 );
$cmd$);
-- Enable only after verifying the channel and recipient. Default remains disabled.
-- update public.line_digest_settings set enabled=true where id;
