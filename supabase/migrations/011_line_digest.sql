-- Private digest queue only. Scheduling and activation are separate deployment steps.
begin;
create table public.line_digest_settings(id boolean primary key default true check(id),enabled boolean not null default false);
insert into public.line_digest_settings default values;
create table public.line_notification_sources(source_key text primary key check(source_key ~ '^[a-z][a-z0-9_-]{0,39}$'),display_name text not null check(length(display_name) between 1 and 40),target_url text not null check(length(target_url)<=500 and target_url ~ '^https://[^[:space:]]+$'),enabled boolean not null default false);
insert into public.line_notification_sources values('meshi','めしマップ','https://syu-syuto.github.io/gakugei-meshi-map/#admin',true);
create table public.line_notification_events(id uuid primary key default gen_random_uuid(),source_key text not null references public.line_notification_sources(source_key),event_key text not null check(length(event_key) between 1 and 200),title text not null check(length(trim(title)) between 1 and 100),kind text not null default 'other' check(kind in ('new','addition','other')),created_at timestamptz not null default now(),dismissed boolean not null default false,unique(source_key,event_key));
create table public.line_digest_batches(id uuid primary key default gen_random_uuid(),created_at timestamptz not null,body jsonb not null,state text not null default 'pending' check(state in ('pending','sent','manual_review')),lease_id uuid,lease_until timestamptz,last_error text not null default '',sent_at timestamptz);
create table public.line_digest_items(event_id uuid primary key references public.line_notification_events(id),batch_id uuid not null references public.line_digest_batches(id));
create table public.line_digest_runs(slot text primary key,batch_id uuid references public.line_digest_batches(id));
alter table public.line_notification_sources enable row level security;
alter table public.line_notification_events enable row level security;
revoke all on public.line_notification_sources,public.line_notification_events from public,anon,authenticated,service_role;
create function public.enqueue_line_notification(p_source text,p_event_key text,p_title text,p_kind text default 'other') returns uuid language plpgsql security definer set search_path='' as $$
declare eid uuid;
begin
 if p_source='meshi' or not exists(select 1 from public.line_notification_sources where source_key=p_source and enabled) then raise exception 'Notification source unavailable'; end if;
 insert into public.line_notification_events(source_key,event_key,title,kind) values(p_source,p_event_key,p_title,p_kind) on conflict(source_key,event_key) do update set event_key=excluded.event_key returning id into eid;
 return eid;
end;$$;
revoke all on function public.enqueue_line_notification(text,text,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_line_notification(text,text,text,text) to service_role;
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
declare slot_key text; b public.line_digest_batches; lease uuid:=gen_random_uuid(); ids uuid[]; list text; links text; text_body text;
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
  insert into public.line_notification_events(source_key,event_key,title,kind,created_at) select 'meshi',s.id::text,s.payload->>'name',s.submission_kind,s.created_at from public.submissions s where s.status='pending' and exists(select 1 from public.line_notification_sources where source_key='meshi' and enabled) on conflict(source_key,event_key) do nothing;
  update public.line_notification_events e set dismissed=true where e.source_key='meshi' and not exists(select 1 from public.submissions s where s.id::text=e.event_key and s.status='pending');
  select array_agg(e.id order by e.created_at,e.id) into ids from public.line_notification_events e join public.line_notification_sources src on src.source_key=e.source_key where src.enabled and not e.dismissed and not exists(select 1 from public.line_digest_items i where i.event_id=e.id);
  if coalesce(cardinality(ids),0)=0 then return jsonb_build_object('status','empty'); end if;
  select string_agg('・['||x.display_name||'] '||case x.kind when 'addition' then '追加：' when 'new' then '新規：' else '' end||left(regexp_replace(x.title,'[[:cntrl:]]',' ','g'),80),E'\n') into list from (select e.kind,e.title,src.display_name from public.line_notification_events e join public.line_notification_sources src on src.source_key=e.source_key where e.id=any(ids) order by e.created_at,e.id limit 15) x;
  select string_agg(x.display_name||E'\n'||x.target_url,E'\n\n') into links from (select distinct src.source_key,src.display_name,src.target_url from public.line_notification_events e join public.line_notification_sources src on src.source_key=e.source_key where e.id=any(ids) order by src.source_key limit 4) x;
  text_body:='📬 しゅうの物置'||E'\n'||slot_key||' のまとめ'||E'\n新しい通知：'||cardinality(ids)||'件'||E'\n\n'||coalesce(list,'')||case when cardinality(ids)>15 then E'\nほか'||(cardinality(ids)-15)||'件' else '' end||E'\n\n詳細：\n'||coalesce(links,'');
  insert into public.line_digest_batches(created_at,body) values(at_time,jsonb_build_object('to',recipient,'messages',jsonb_build_array(jsonb_build_object('type','text','text',text_body)))) returning * into b;
  insert into public.line_digest_items(event_id,batch_id) select unnest(ids),b.id;
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
