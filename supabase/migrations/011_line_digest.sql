-- Private digest queue only. Scheduling and activation are separate deployment steps.
begin;
create table public.line_digest_settings(id boolean primary key default true check(id),enabled boolean not null default false);
insert into public.line_digest_settings default values;
create table public.line_digest_batches(id uuid primary key default gen_random_uuid(),created_at timestamptz not null,body jsonb not null,state text not null default 'pending' check(state in ('pending','sent','manual_review')),lease_id uuid,lease_until timestamptz,last_error text not null default '',sent_at timestamptz);
create table public.line_digest_items(submission_id uuid primary key references public.submissions(id),batch_id uuid not null references public.line_digest_batches(id));
create table public.line_digest_runs(slot text primary key,batch_id uuid references public.line_digest_batches(id));
alter table public.line_digest_settings enable row level security;
alter table public.line_digest_batches enable row level security;
alter table public.line_digest_items enable row level security;
alter table public.line_digest_runs enable row level security;
revoke all on public.line_digest_settings,public.line_digest_batches,public.line_digest_items,public.line_digest_runs from public,anon,authenticated,service_role;
create function public.line_digest_slot(at_time timestamptz) returns text language sql immutable set search_path='' as $$
 select case when extract(hour from at_time at time zone 'Asia/Tokyo') in (6,9,12,16,21) and extract(minute from at_time at time zone 'Asia/Tokyo')<15 then to_char(at_time at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:00') end;
$$;
revoke all on function public.line_digest_slot(timestamptz) from public,anon,authenticated;
create function public.prepare_line_digest_internal(recipient text,at_time timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare slot_key text; b public.line_digest_batches; lease uuid:=gen_random_uuid(); ids uuid[]; list text; fresh integer; additions integer; text_body text;
begin
 if not (select enabled from public.line_digest_settings where id) then return jsonb_build_object('status','disabled'); end if;
 if recipient !~ '^U[0-9a-f]{32}$' or recipient is null then raise exception 'Invalid recipient'; end if;
 slot_key:=public.line_digest_slot(at_time);if slot_key is null then return jsonb_build_object('status','outside_schedule'); end if;
 perform pg_advisory_xact_lock(615121);
 if exists(select 1 from public.line_digest_batches where state='manual_review') then return jsonb_build_object('status','manual_review'); end if;
 insert into public.line_digest_runs(slot) values(slot_key) on conflict do nothing;
 if not found then return jsonb_build_object('status','already_run'); end if;
 select * into b from public.line_digest_batches where state='pending' order by created_at limit 1 for update;
 if found then
  if b.created_at<at_time-interval '23 hours' then update public.line_digest_batches set state='manual_review',last_error='retry_window_expired' where id=b.id;return jsonb_build_object('status','manual_review'); end if;
  if b.lease_until>at_time then return jsonb_build_object('status','busy'); end if;
 else
  select array_agg(s.id order by s.created_at,s.id),count(*) filter(where s.submission_kind='new'),count(*) filter(where s.submission_kind='addition') into ids,fresh,additions from public.submissions s where s.status='pending' and not exists(select 1 from public.line_digest_items i where i.submission_id=s.id);
  if coalesce(cardinality(ids),0)=0 then return jsonb_build_object('status','empty'); end if;
  select string_agg('・'||case when x.submission_kind='addition' then '追加：' else '新規：' end||left(regexp_replace(x.payload->>'name','[[:cntrl:]]',' ','g'),100),E'\n') into list from (select s.submission_kind,s.payload from public.submissions s where s.id=any(ids) order by s.created_at,s.id limit 20) x;
  text_body:='🍚 学芸大めしマップ'||E'\n'||slot_key||' のまとめ'||E'\n新規店舗：'||fresh||'件'||E'\n追加情報：'||additions||'件'||E'\n\n'||coalesce(list,'')||case when cardinality(ids)>20 then E'\nほか'||(cardinality(ids)-20)||'件' else '' end||E'\n\n管理画面：\nhttps://syu-syuto.github.io/gakugei-meshi-map/#admin';
  insert into public.line_digest_batches(created_at,body) values(at_time,jsonb_build_object('to',recipient,'messages',jsonb_build_array(jsonb_build_object('type','text','text',text_body)))) returning * into b;
  insert into public.line_digest_items(submission_id,batch_id) select unnest(ids),b.id;
 end if;
 update public.line_digest_batches set lease_id=lease,lease_until=at_time+interval '10 minutes' where id=b.id;
 update public.line_digest_runs set batch_id=b.id where slot=slot_key;
 return jsonb_build_object('status','ready','id',b.id,'lease_id',lease,'body',b.body);
end;$$;
revoke all on function public.prepare_line_digest_internal(text,timestamptz) from public,anon,authenticated,service_role;
create function public.prepare_line_digest(recipient text) returns jsonb language sql security definer set search_path='' as $$ select public.prepare_line_digest_internal(recipient,now()); $$;
revoke all on function public.prepare_line_digest(text) from public,anon,authenticated;
grant execute on function public.prepare_line_digest(text) to service_role;
create function public.finish_line_digest(batch_id uuid,lease_id uuid,sent boolean,error_code text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(615121);
 update public.line_digest_batches b set state=case when sent then 'sent' else 'pending' end,sent_at=case when sent then now() else null end,last_error=case when sent then '' else left(coalesce(error_code,'unknown'),100) end,lease_until=null,lease_id=null where b.id=batch_id and b.lease_id=finish_line_digest.lease_id and b.state='pending';
 if not found then raise exception 'Digest lease changed'; end if;
end;$$;
revoke all on function public.finish_line_digest(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.finish_line_digest(uuid,uuid,boolean,text) to service_role;
commit;
