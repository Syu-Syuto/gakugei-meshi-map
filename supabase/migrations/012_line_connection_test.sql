-- One private connection test, with the same retry safeguards as scheduled delivery.
begin;
create function public.prepare_line_connection_test(recipient text) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.line_digest_batches; lease uuid:=gen_random_uuid();
begin
 if recipient is null or recipient !~ '^U[0-9a-f]{32}$' then raise exception 'Invalid recipient'; end if;
 perform pg_advisory_xact_lock(615121);
 select batch.* into b from public.line_digest_runs r join public.line_digest_batches batch on batch.id=r.batch_id where r.slot='connection_test' for update of batch;
 if found then
  if b.state='sent' then return jsonb_build_object('status','already_sent'); end if;
  if b.state='manual_review' or b.created_at<now()-interval '23 hours' then return jsonb_build_object('status','manual_review'); end if;
  if b.lease_until>now() then return jsonb_build_object('status','busy'); end if;
 else
  insert into public.line_digest_batches(created_at,body) values(now(),jsonb_build_object('to',recipient,'messages',jsonb_build_array(jsonb_build_object('type','text','text',E'📬 しゅうの物置\nLINE通知の接続テストです。\n通知予定：毎日6:00・9:00・12:00・16:00・21:00（日本時間）。新しい通知がある回だけまとめます。\n最初の通知元：学芸大めしマップ\nhttps://syu-syuto.github.io/gakugei-meshi-map/#admin')))) returning * into b;
  insert into public.line_digest_runs(slot,batch_id) values('connection_test',b.id);
 end if;
 update public.line_digest_batches set lease_id=lease,lease_until=now()+interval '10 minutes' where id=b.id;
 return jsonb_build_object('status','ready','id',b.id,'lease_id',lease,'body',b.body);
end;$$;
revoke all on function public.prepare_line_connection_test(text) from public,anon,authenticated;
grant execute on function public.prepare_line_connection_test(text) to service_role;
commit;
