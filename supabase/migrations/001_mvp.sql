-- Run once in a NEW Supabase project's SQL editor.
begin;
create table public.admins(user_id uuid primary key references auth.users(id) on delete cascade);
create table public.restaurants(
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 100),
 genre text not null check(genre in ('定食','ラーメン','カレー','カフェ','その他')),
 price_yen integer check(price_yen between 0 and 100000),
 lat double precision not null check(lat between 35.67 and 35.74),
 lng double precision not null check(lng between 139.45 and 139.53),
 address text not null default '' check(length(address)<=250),
 walk_m integer not null check(walk_m between 1 and 2000),
 source_kind text not null check(source_kind in ('osm','official','field')),
 source_url text not null default '', source_note text not null,
 route_note text not null, verified_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);
create unique index restaurants_osm_unique on public.restaurants(source_url) where source_kind='osm';
create table public.submissions(
 id uuid primary key default gen_random_uuid(), submitter_id uuid not null references auth.users(id),
 payload jsonb not null, status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(), reviewed_at timestamptz, reviewed_by uuid references auth.users(id),
 review_note text, restaurant_id uuid references public.restaurants(id)
);
create index submissions_pending on public.submissions(created_at) where status='pending';
create index submissions_by_user on public.submissions(submitter_id,created_at);
-- Reviews remain closed to writes until the review UI, reporting and moderation RPC are ready.
create table public.reviews(
 id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants(id),
 author_id uuid not null references auth.users(id), rating smallint not null check(rating between 1 and 5),
 comment text not null check(length(comment) between 1 and 1000),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(), reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
 unique(restaurant_id,author_id)
);
create table public.api_limits(user_id uuid not null, bucket text not null, window_start timestamptz not null, hits integer not null, primary key(user_id,bucket,window_start));
create table public.osm_cache(id text primary key, data jsonb not null, updated_at timestamptz not null default now());

alter table public.admins enable row level security;
alter table public.restaurants enable row level security;
alter table public.submissions enable row level security;
alter table public.reviews enable row level security;
alter table public.api_limits enable row level security;
alter table public.osm_cache enable row level security;
revoke all on public.admins,public.restaurants,public.submissions,public.reviews,public.api_limits,public.osm_cache from anon,authenticated;
grant select on public.restaurants to anon,authenticated;
grant select on public.submissions to authenticated;
grant select(id,restaurant_id,rating,comment,created_at) on public.reviews to anon,authenticated;
grant all on public.osm_cache,public.api_limits to service_role;

create function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and coalesce((auth.jwt()->>'is_anonymous')::boolean,true)=false
 and exists(select 1 from public.admins where user_id=auth.uid());
$$;
create policy restaurants_read on public.restaurants for select using(true);
create policy submission_read on public.submissions for select to authenticated using(submitter_id=auth.uid() or public.is_admin());
create policy reviews_read on public.reviews for select using(status='approved');

-- Service-only limiter for Edge Functions; DB mutation RPC has its own limiter.
create function public.take_api_slot(who uuid, bucket_name text, max_hits integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if who is null or max_hits<1 or max_hits>100 then return false; end if;
 insert into public.api_limits values(who,bucket_name,date_trunc('hour',now()),1)
 on conflict(user_id,bucket,window_start) do update set hits=public.api_limits.hits+1 returning hits into n;
 return n<=max_hits;
end;$$;

create function public.valid_source(kind text, url text) returns boolean language sql immutable set search_path='' as $$
 select case when kind='field' and url='' then true
 when kind='osm' then url ~ '^https://www[.]openstreetmap[.]org/(node|way|relation)/[0-9]+$'
 when kind in ('official','field') then
 url ~ '^https://[a-zA-Z0-9.-]+(:443)?(/|$)' and length(url)<=2048
 and url !~* '^https://([^/]*[.])?(google[.][^/]+|goo[.]gl|gstatic[.]com|googleusercontent[.]com)(/|:|$)'
 else false end;
$$;

create function public.submit_restaurant(p jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); d jsonb; new_id uuid; budget integer;
begin
 if uid is null then raise exception '認証が必要です'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 if (select count(*) from public.submissions where submitter_id=uid and created_at>now()-interval '1 day')>=5 then raise exception '投稿は1日5件までです'; end if;
 if (select count(*) from public.submissions where submitter_id=uid and created_at>now()-interval '60 seconds')>0 then raise exception '次の投稿まで1分お待ちください'; end if;
 if coalesce(p->>'confirmed','')<>'true' or jsonb_typeof(p)<>'object' then raise exception '内容確認が必要です'; end if;
 if length(trim(coalesce(p->>'name',''))) not between 1 and 100
 or coalesce(p->>'genre','') not in ('定食','ラーメン','カレー','カフェ','その他')
 or length(coalesce(p->>'address',''))>250
 or length(trim(coalesce(p->>'source_note',''))) not between 5 and 1000
 or coalesce(p->>'source_kind','') not in ('osm','official','field')
 or not public.valid_source(p->>'source_kind',coalesce(p->>'source_url','')) then raise exception '店名・ジャンル・確認情報を確認してください'; end if;
 if p->>'lat' is null or p->>'lng' is null then raise exception '場所が必要です'; end if;
 if (p->>'lat')::double precision not between 35.67 and 35.74 or (p->>'lng')::double precision not between 139.45 and 139.53 then raise exception '対象範囲の場所を指定してください'; end if;
 if p->>'price_yen' is not null then
   if (p->>'price_yen') !~ '^[0-9]{1,6}$' then raise exception '予算は整数です'; end if;
   budget:=(p->>'price_yen')::integer;
   if budget not between 0 and 100000 then raise exception '予算の範囲を確認してください'; end if;
 end if;
 -- Whitelist fields: clients cannot set status, owner, walking distance or approval.
 d:=jsonb_build_object('name',trim(p->>'name'),'genre',p->>'genre','price_yen',budget,
 'lat',(p->>'lat')::double precision,'lng',(p->>'lng')::double precision,
 'address',coalesce(p->>'address',''),'source_kind',p->>'source_kind',
 'source_url',coalesce(p->>'source_url',''),'source_note',trim(p->>'source_note'),'confirmed',true);
 insert into public.submissions(submitter_id,payload) values(uid,d) returning id into new_id;
 return new_id;
end;$$;

create function public.moderate_submission(submission_id uuid,approve boolean,walk_m integer,review_note text) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.submissions; d jsonb; rid uuid;
begin
 if not public.is_admin() then raise exception '管理者権限が必要です'; end if;
 -- Serialize approvals to prevent concurrent duplicate insertion.
 perform pg_advisory_xact_lock(128741235);
 select * into s from public.submissions where id=submission_id for update;
 if not found or s.status<>'pending' then raise exception '投稿が見つからないか処理済みです'; end if;
 if approve is null or length(trim(coalesce(review_note,''))) not between 1 and 1000 then raise exception '審査結果と確認メモが必要です'; end if;
 if approve then
   if walk_m is null or walk_m not between 1 and 2000 or length(trim(review_note))<10 then raise exception '徒歩25分以内の歩行距離と経路の確認記録が必要です'; end if;
   d:=s.payload;
   if exists(select 1 from public.restaurants r where lower(trim(r.name))=lower(trim(d->>'name')) and abs(r.lat-(d->>'lat')::double precision)<0.001 and abs(r.lng-(d->>'lng')::double precision)<0.001) then raise exception '同名の近隣店舗が登録されています'; end if;
   insert into public.restaurants(name,genre,price_yen,lat,lng,address,walk_m,source_kind,source_url,source_note,route_note)
   values(d->>'name',d->>'genre',(d->>'price_yen')::integer,(d->>'lat')::double precision,(d->>'lng')::double precision,d->>'address',walk_m,d->>'source_kind',d->>'source_url',d->>'source_note',review_note) returning id into rid;
 end if;
 update public.submissions set status=case when approve then 'approved' else 'rejected' end,
 reviewed_at=now(),reviewed_by=auth.uid(),review_note=moderate_submission.review_note,restaurant_id=rid where id=submission_id;
 return rid;
end;$$;
revoke all on function public.is_admin(),public.valid_source(text,text),public.submit_restaurant(jsonb),public.moderate_submission(uuid,boolean,integer,text),public.take_api_slot(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.is_admin(),public.submit_restaurant(jsonb),public.moderate_submission(uuid,boolean,integer,text) to authenticated;
grant execute on function public.take_api_slot(uuid,text,integer) to service_role;
commit;
