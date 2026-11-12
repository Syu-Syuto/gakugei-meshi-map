-- Apply once after 009. No existing submissions are converted automatically.
begin;
create function public.restaurant_name_key(value text) returns text language sql immutable strict set search_path='' as $$
 select regexp_replace(lower(normalize(value,NFKC)),'[[:space:]・]','','g');
$$;
revoke all on function public.restaurant_name_key(text) from public,anon,authenticated;
alter function public.submit_restaurant(jsonb) rename to submit_restaurant_v9_private;
revoke all on function public.submit_restaurant_v9_private(jsonb) from public,anon,authenticated;
create function public.submit_restaurant(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception '認証が必要です'; end if;
 if nullif(p->>'target_restaurant_id','') is null and exists(select 1 from public.restaurants r where r.is_published and public.restaurant_name_key(r.name)=public.restaurant_name_key(p->>'name')) then
  raise exception 'この店名は登録済みです。既存のお店の詳細から「このお店に情報を追加」を選んでください';
 end if;
 return public.submit_restaurant_v9_private(p);
end;$$;
revoke all on function public.submit_restaurant(jsonb) from public,anon,authenticated;
grant execute on function public.submit_restaurant(jsonb) to authenticated;
alter function public.review_submission(uuid,boolean,jsonb) rename to review_submission_v9_private;
revoke all on function public.review_submission_v9_private(uuid,boolean,jsonb) from public,anon,authenticated;
create function public.review_submission(submission_id uuid,approve boolean,review_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.submissions;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 perform pg_advisory_xact_lock(128741235);
 select * into s from public.submissions where id=submission_id;
 if approve and s.status='pending' and s.submission_kind='new' and exists(select 1 from public.restaurants r where public.restaurant_name_key(r.name)=public.restaurant_name_key(coalesce(review_data->>'name',s.payload->>'name'))) then
  raise exception '同じ店名の店舗が登録済みです。「既存のお店への追加情報に切り替える」から追加先を選んでください';
 end if;
 return public.review_submission_v9_private(submission_id,approve,review_data);
end;$$;
revoke all on function public.review_submission(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.review_submission(uuid,boolean,jsonb) to authenticated;
create table public.submission_conversion_events(
 id bigint generated always as identity primary key,
 submission_id uuid not null references public.submissions(id),
 target_restaurant_id uuid not null references public.restaurants(id),
 changed_by uuid not null references auth.users(id),changed_at timestamptz not null default now(),
 original_payload jsonb not null
);
alter table public.submission_conversion_events enable row level security;
revoke all on public.submission_conversion_events from public,anon,authenticated;
grant select on public.submission_conversion_events to authenticated;
create policy conversion_events_admin on public.submission_conversion_events for select to authenticated using(public.is_admin());
create function public.convert_submission_to_addition(submission_id uuid,target_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.submissions; r public.restaurants;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 perform pg_advisory_xact_lock(128741235);
 select * into s from public.submissions where id=submission_id for update;
 if not found or s.status<>'pending' or s.submission_kind<>'new' then raise exception '新規の審査待ち投稿ではありません。再読み込みしてください'; end if;
 select * into r from public.restaurants where id=target_id for share;
 if not found then raise exception '追加先の店舗が見つかりません'; end if;
 insert into public.submission_conversion_events(submission_id,target_restaurant_id,changed_by,original_payload) values(s.id,r.id,auth.uid(),s.payload);
 update public.submissions set submission_kind='addition',target_restaurant_id=r.id,payload=s.payload||jsonb_build_object('name',r.name,'genre',r.genre,'address',r.address,'lat',null,'lng',null,'walk_m',null) where id=s.id;
 delete from public.admin_blank_checks where subject_id=s.id and scope='approve';
end;$$;
revoke all on function public.convert_submission_to_addition(uuid,uuid) from public,anon,authenticated;
grant execute on function public.convert_submission_to_addition(uuid,uuid) to authenticated;
commit;
