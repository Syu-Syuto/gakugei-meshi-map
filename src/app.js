import {preparePhoto} from './photos.js';
import {config} from '../config.js';
import {parseGoogleUrl,validateSubmission,filterRestaurants,demoRestaurants,safeSource,travelLabel,budgetLabel,PARKING_LABELS,restaurantLinks} from './core.js';
const $=s=>document.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const demo=!config.supabaseUrl || !config.supabasePublishableKey;
let preparedPhoto=null,photoError='',photoProcessing=Promise.resolve(),photoGeneration=0,previewUrl='';
let db,rows=[],pending=[],map,markers,pickedMarker,selectedId,picking=false,session,widgetIds={},tokens={};
const form=$('#submission-form');
const setStatus=(id,message)=>$(id).textContent=message;
const busy=async(button,fn,status)=>{button.disabled=true;try{await fn();}catch(e){setStatus(status,e.message||'処理に失敗しました。再度お試しください。');}finally{button.disabled=false;}};
function externalLink(url,text){const a=el('a',text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
async function captcha(where){
  if(demo||!config.turnstileSiteKey||widgetIds[where]!==undefined)return;
  if(!window.turnstile){await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.onload=resolve;s.onerror=()=>reject(new Error('人間確認を読み込めませんでした。'));document.head.append(s);});}
  widgetIds[where]=window.turnstile.render(`#captcha-${where}`,{sitekey:config.turnstileSiteKey,callback:t=>tokens[where]=t,'expired-callback':()=>tokens[where]=null});
}
function resetCaptcha(where){tokens[where]=null;if(widgetIds[where]!==undefined)window.turnstile.reset(widgetIds[where]);}
async function ensureSession(){
  const {data}=await db.auth.getSession();if(data.session)return data.session;
  if(!tokens.submit)throw new Error('人間確認を完了してから検索・投稿してください。');
  const result=await db.auth.signInAnonymously({options:{captchaToken:tokens.submit}});resetCaptcha('submit');if(result.error)throw result.error;return result.data.session;
}
function openSubmission(){ $('#submit-dialog').showModal();captcha('submit').catch(e=>setStatus('#submit-status',e.message)); }
$('#open-submit').onclick=openSubmission;$('#open-submit-bottom').onclick=openSubmission;
function initMap(){
  if(!window.L){$('#map').append(el('p','地図を読み込めませんでした。店舗一覧と座標入力は利用できます。','empty'));return;}
  map=L.map('map',{scrollWheelZoom:false}).setView(config.campus,15);
  L.tileLayer(config.tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',detectRetina:false}).addTo(map);
  L.marker(config.campus,{icon:L.divIcon({html:'<span class="pin campus-pin">学</span>',className:'',iconSize:[30,30]})}).addTo(map).bindPopup('東京学芸大学 小金井キャンパス（地図中心の目安）');
  markers=L.layerGroup().addTo(map);
  map.on('click',e=>{if(!picking)return;picking=false;form.elements.lat.value=e.latlng.lat.toFixed(6);form.elements.lng.value=e.latlng.lng.toFixed(6);if(pickedMarker)map.removeLayer(pickedMarker);pickedMarker=L.marker(e.latlng).addTo(map);setStatus('#location-status','地図で場所を指定しました。店名と位置を確認してください。');$('#submit-dialog').showModal();});
}
function getFilters(){return Object.fromEntries(['search','genre','price','travel','distance','purpose','parking','sort'].map(k=>[k,$('#'+k).value]));}
function updateTravelHelp(){setStatus('#travel-help',$('#travel').value==='bicycle'?'自転車の目安：徒歩経路の距離を200m/分で換算。走行可能な経路・信号待ち・駐輪時間は未確認です。':'徒歩の目安：確認した歩行経路の距離を80m/分で換算。掲載範囲は徒歩約25分以内です。');}
$('#travel').addEventListener('change',updateTravelHelp);
function render(){
  if(demo&&!picking)setStatus('#mode','動作確認用のサンプルを表示しています。実在するお店ではありません。');
  const shown=filterRestaurants(rows,getFilters());$('#count').textContent=shown.length;$('#results').replaceChildren();markers?.clearLayers();
  if(!shown.length)$('#results').append(el('p','条件に合うお店がありません。絞り込み条件を変えてみてください。','empty'));
  shown.forEach((r,i)=>{
    const b=el('button',undefined,'card'+(selectedId===r.id?' selected':''));b.type='button';
    const top=el('div',undefined,'card-top');top.append(el('span',r.genre,'tag'),el('span',travelLabel(r,$('#travel').value),'walk'));
    const bottom=el('div',undefined,'card-bottom');bottom.append(el('strong',budgetLabel(r)),el('span','詳細'));
    b.append(el('span',String(i+1).padStart(2,'0'),'card-index'),top,el('h3',r.name),el('p',(r.address||'住所未登録')+' · '+PARKING_LABELS[r.bicycle_parking??'unknown'],'address'),bottom);b.onclick=()=>showDetail(r);$('#results').append(b);
    if(markers){const m=L.marker([r.lat,r.lng],{icon:L.divIcon({html:`<span class="pin">${i+1}</span>`,className:'',iconSize:[30,30]})}).addTo(markers);m.bindTooltip(r.name);m.on('click',()=>showDetail(r));}
  });
}
document.addEventListener('export-restaurants',()=>{
  const data={attribution:'© OpenStreetMap contributors and Gakugei Meshi Map contributors',license:'ODbL-1.0',license_url:'https://opendatacommons.org/licenses/odbl/1-0/',demo,exported_at:new Date().toISOString(),restaurants:rows.map(({_demo_photo_url,...r})=>r)};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=demo?'gakugei-meshi-DEMO.json':'gakugei-meshi-ODbL.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function appendPurposes(container,r){if(!r.purposes?.length)return;const section=el('section',undefined,'recommendation');section.append(el('h3','向いている目的'),el('p',r.purposes.join('・')));if(r.purpose_note)section.append(el('p',r.purpose_note));section.append(el('p','団体利用の人数・予約条件はお店にご確認ください。','help'));container.append(section);}
async function appendPhoto(container,r){
 if(!r.photo_path&&!r._demo_photo_url)return;const figure=el('figure',undefined,'store-photo');const img=el('img');img.alt=r.name+'への投稿写真';img.loading='lazy';const caption=el('figcaption','投稿写真（掲載許諾済み）');figure.append(img,caption);container.append(figure);
 try{if(demo){if(!r._demo_photo_url)throw new Error();img.src=r._demo_photo_url;}else{const {data,error}=await db.storage.from('restaurant-photos').createSignedUrl(r.photo_path,300);if(error)throw error;img.src=data.signedUrl;}img.onerror=()=>{img.hidden=true;caption.textContent='写真を読み込めませんでした。詳細を開き直してください。';};}catch{img.hidden=true;caption.textContent='写真を読み込めませんでした。';}
}
function appendRecommendation(container,r){
 if(!r.recommended_menu&&!r.highlight)return;
 const section=el('section',undefined,'recommendation');section.append(el('h3','投稿者のおすすめ'));
 if(r.recommended_menu){section.append(el('p',r.recommended_menu+(r.menu_price_yen==null?'':` · ${Number(r.menu_price_yen).toLocaleString()}円`)));}
 if(r.highlight)section.append(el('p',r.highlight));
 section.append(el('p','投稿時点の情報です。現在のメニュー・価格はお店でご確認ください。','help'));container.append(section);
}
function showDetail(r){selectedId=r.id;render();map?.panTo([r.lat,r.lng]);$('#detail-title').textContent=r.name;const c=$('#detail-content');c.replaceChildren();c.append(el('p',`${r.genre} · ${budgetLabel(r)} · ${travelLabel(r,$('#travel').value)}`),el('p',r.address||''),el('p',PARKING_LABELS[r.bicycle_parking??'unknown']+(r.parking_note?'：'+r.parking_note:'')),el('p',r.source_note||''));appendPurposes(c,r);appendRecommendation(c,r);appendPhoto(c,r);const links=el('nav',undefined,'store-links');links.setAttribute('aria-label','店舗の外部リンク');for(const link of restaurantLinks(r))links.append(externalLink(link.url,link.label+' ↗'));c.append(links);if(!r.google_maps_url)c.append(el('p','Googleマップの店舗URLは未登録のため、店名で検索します。','help'));if(r.source_url){try{safeSource(r.source_url,r.source_kind);c.append(externalLink(r.source_url,'掲載情報の出典 ↗'));}catch{}}if(r.route_note)c.append(el('p','歩行経路の確認：'+r.route_note,'help'));$('#detail-dialog').showModal();}
['search','genre','price','travel','distance','purpose','parking','sort'].forEach(k=>$('#'+k).addEventListener(k==='search'?'input':'change',render));
$('#reset').onclick=()=>{$('#search').value='';$('#genre').value='';$('#price').value='';$('#distance').value='25';$('#travel').value='walk';$('#parking').value='';$('#purpose').value='';updateTravelHelp();$('#sort').value='distance';render();};
async function load(){if(demo){rows=[...demoRestaurants,...pending.filter(p=>p.status==='approved').map(p=>({...p,id:p.id+'-published'}))];}else{const result=await db.from('restaurants').select('*').order('walk_m');if(result.error)throw result.error;rows=result.data;}render();}
$('#parse-url').onclick=()=>{try{const p=parseGoogleUrl($('#google-url').value);if(p.hint)$('#candidate-query').value=p.hint;setStatus('#url-status',p.hint?`店名の候補：${p.hint}。下の検索でお店を確認してください。`:'このリンクからは店名がわかりませんでした。店名を下の欄に入力してください。');}catch(e){setStatus('#url-status',e.message);}};
$('#find-candidates').onclick=e=>busy(e.currentTarget,async()=>{
  const query=$('#candidate-query').value.trim();if(query.length<2)throw new Error('店名を2文字以上入力してください。');
  const c=$('#candidates');c.replaceChildren(el('p','候補を確認しています…','help'));
  if(demo){c.replaceChildren(el('p','デモではOSM検索に接続しません。手入力と地図指定で投稿を試せます。Supabase接続後に実際の候補を検索できます。','help'));return;}
  await ensureSession();const {data,error}=await db.functions.invoke('osm-candidates',{body:{query}});if(error)throw new Error('候補検索に失敗しました。手入力で続けるか、しばらくして再度お試しください。');
  c.replaceChildren();if(!data.candidates.length)c.append(el('p','候補が見つかりません。手入力と地図指定で続けられます。','help'));
  for(const candidate of data.candidates){const box=el('div',undefined,'candidate'),b=el('button',candidate.name+' を選択');b.type='button';b.onclick=()=>{for(const key of ['name','lat','lng','address','source_url'])form.elements[key].value=candidate[key]||'';form.elements.source_kind.value='osm';form.elements.source_note.value='OSMの店舗候補を確認。現在の営業状況は管理者審査で再確認。';setStatus('#location-status','OSM候補を選択しました。位置とお店を確認してください。');};box.append(b,externalLink(candidate.source_url,'OSMで確認 ↗'));c.append(box);}c.append(el('p','© OpenStreetMap contributors · ODbL。候補は自動確定されません。','help'));
},'#url-status');
$('#pick-location').onclick=()=>{if(!map){setStatus('#location-status','地図を利用できません。緯度・経度を直接入力してください。');return;}picking=true;$('#submit-dialog').close();$('#map').scrollIntoView({behavior:'smooth',block:'center'});setStatus('#mode','投稿する店舗の位置を地図上でタップしてください。');};
$('#photo').addEventListener('change',()=>{
 const generation=++photoGeneration;preparedPhoto=null;photoError='';if(previewUrl)URL.revokeObjectURL(previewUrl);$('#photo-preview').hidden=true;const file=$('#photo').files[0];
 if(!file){setStatus('#photo-status','');photoProcessing=Promise.resolve();return;}
 setStatus('#photo-status','写真を準備しています…');
 photoProcessing=preparePhoto(file).then(blob=>{if(generation!==photoGeneration)return;preparedPhoto=blob;previewUrl=URL.createObjectURL(blob);$('#photo-preview').src=previewUrl;$('#photo-preview').hidden=false;setStatus('#photo-status','写真を選択しました。承認されるまで公開されません。');}).catch(e=>{if(generation!==photoGeneration)return;photoError=e.message;setStatus('#photo-status',e.message);});
});
form.addEventListener('submit',e=>{e.preventDefault();busy(form.querySelector('[type=submit]'),async()=>{
  await photoProcessing;if(photoError)throw new Error(photoError);const formData=new FormData(form);const d=Object.fromEntries(formData);d.purposes=formData.getAll('purposes');d.purpose_note=d.purpose_note.trim();d.photo_confirmed=!!d.photo_confirmed;d.photo_path='';if(preparedPhoto&&!d.photo_confirmed)throw new Error('写真の確認事項に同意してください。');d.lat=Number(d.lat);d.lng=Number(d.lng);d.budget_yen=d.budget_yen===''?null:Number(d.budget_yen);d.menu_price_yen=d.menu_price_yen===''?null:Number(d.menu_price_yen);d.recommended_menu=d.recommended_menu.trim();d.highlight=d.highlight.trim();d.confirmed=!!d.confirmed;d.google_maps_url=d.google_maps_url.trim();d.official_url=d.official_url.trim();validateSubmission(d);
  // Store user-provided links only; never fetch Google pages or copy their data.
  delete d.website;
  if(demo){if(preparedPhoto){d.photo_path=crypto.randomUUID()+'.jpg';d._demo_photo_url=URL.createObjectURL(preparedPhoto);}pending.push({...d,id:crypto.randomUUID(),status:'pending',created_at:new Date().toISOString()});}
  else{await ensureSession();if(preparedPhoto){const slot=await db.rpc('reserve_restaurant_photo');if(slot.error)throw slot.error;d.photo_path=slot.data;setStatus('#submit-status','写真を送信しています…');const upload=await db.storage.from('restaurant-photos').upload(d.photo_path,preparedPhoto,{contentType:'image/jpeg',upsert:false});if(upload.error)throw new Error('写真の送信に失敗しました。しばらくして再度お試しください。');}const {error}=await db.rpc('submit_restaurant',{p:d});if(error)throw error;}
  form.reset();preparedPhoto=null;photoGeneration++;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';$('#photo-preview').hidden=true;setStatus('#photo-status','');$('#candidates').replaceChildren();setStatus('#location-status','場所が未指定です。');setStatus('#submit-status',demo?'デモの審査待ちに追加しました。「管理」から承認を試せます。このページを再読み込みすると消えます。':'審査に送りました。承認されるまで公開されません。');
},'#submit-status');});
async function adminCheck(){if(demo)return true;const {data,error}=await db.rpc('is_admin');if(error)throw error;return data===true;}
async function showQueue(){
  if(!await adminCheck())throw new Error('管理者権限がありません。');
  $('#login-form').hidden=true;$('#admin-tools').hidden=false;$('#queue').replaceChildren();
  let queue=pending.filter(p=>p.status==='pending');if(!demo){const r=await db.from('submissions').select('*').eq('status','pending').order('created_at');if(r.error)throw r.error;queue=r.data;}
  if(!queue.length)$('#queue').append(el('p','審査待ちの投稿はありません。','empty'));
  for(const item of queue){const d=demo?item:item.payload,box=el('div',undefined,'queue-item');box.append(el('h3',d.name),el('p',`${d.genre} / ${budgetLabel(d)} / ${d.lat}, ${d.lng}`),el('p',d.address||''),el('p',(PARKING_LABELS[d.bicycle_parking??'unknown'])+'：'+(d.parking_note||'補足なし')),el('p',`${d.source_kind}：${d.source_note}`));
    appendPurposes(box,d);appendRecommendation(box,d);appendPhoto(box,d);const links=el('nav',undefined,'store-links');for(const link of restaurantLinks(d))links.append(externalLink(link.url,link.label+' ↗'));box.append(links);if(d.source_url){try{safeSource(d.source_url,d.source_kind);box.append(externalLink(d.source_url,'独立情報源を開く ↗'));}catch{box.append(el('p','情報源URLを再確認してください。'));}}
    box.append(externalLink(`https://www.openstreetmap.org/?mlat=${encodeURIComponent(d.lat)}&mlon=${encodeURIComponent(d.lng)}#map=18/${encodeURIComponent(d.lat)}/${encodeURIComponent(d.lng)}`,'位置をOSMで確認 ↗'));
    const review=el('form');const route=el('input');route.type='number';route.min='1';route.max='2000';route.required=true;route.placeholder='確認した歩行距離（m・最大2000）';const note=el('textarea');note.required=true;note.minLength=10;note.maxLength=1000;note.placeholder='起点のキャンパス入口・経路・確認日・根拠URLまたは実歩行記録（10文字以上）';const check=el('input');check.type='checkbox';check.required=true;const label=el('label',undefined,'check');label.append(check,el('span','営業状況・目的・写真の内容と権利・予算・駐輪・おすすめ・リンク・出典・位置・重複・徒歩経路を確認済み'));
    const approve=el('button','確認して公開','primary');approve.type='submit';const reject=el('button','却下','quiet');reject.type='button';const reason=el('input');reason.placeholder='却下理由（必須）';reason.maxLength=500;
    review.append(route,note,label,approve,reason,reject);box.append(review);$('#queue').append(box);
    review.onsubmit=e=>{e.preventDefault();busy(approve,async()=>{await moderate(item.id,true,Number(route.value),note.value);await showQueue();await load();},'#admin-status');};
    reject.onclick=()=>busy(reject,async()=>{if(!reason.value.trim())throw new Error('却下理由を入力してください。');await moderate(item.id,false,null,reason.value);await showQueue();},'#admin-status');
  }
}
async function moderate(id,approve,walk_m,note){if(demo){const p=pending.find(p=>p.id===id);if(p.status!=='pending')throw new Error('処理済みです。');p.status=approve?'approved':'rejected';p.walk_m=walk_m;p.route_note=note;}else{const {error}=await db.rpc('moderate_submission',{submission_id:id,approve,walk_m,review_note:note});if(error)throw error;}setStatus('#admin-status',approve?'店舗を公開しました。':'投稿を却下しました。');}
$('#open-admin').onclick=async()=>{$('#admin-dialog').showModal();try{if(demo){setStatus('#admin-status','デモ用の審査画面です。実際の管理者権限はSupabase側で検証します。');await showQueue();}else{await captcha('admin');if(await adminCheck())await showQueue();}}catch(e){setStatus('#admin-status',e.message);}};
$('#login-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{if(!tokens.admin)throw new Error('人間確認を完了してください。');const f=new FormData(e.target);const {error}=await db.auth.signInWithPassword({email:f.get('email'),password:f.get('password'),options:{captchaToken:tokens.admin}});resetCaptcha('admin');if(error)throw error;e.target.reset();await showQueue();},'#admin-status');};
$('#logout').onclick=async()=>{if(!demo)await db.auth.signOut();$('#admin-tools').hidden=true;$('#login-form').hidden=false;setStatus('#admin-status','ログアウトしました。');};
$('#refresh-queue').onclick=e=>busy(e.currentTarget,showQueue,'#admin-status');
async function start(){
  setStatus('#mode',demo?'動作確認用のサンプルを表示しています。実在するお店ではありません。':'追加されたお店は、内容を確認してから掲載します。');
  initMap();if(!demo){const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');db=createClient(config.supabaseUrl,config.supabasePublishableKey);}
  await load();
}
start().catch(e=>{setStatus('#mode','読み込みに失敗しました：'+e.message);$('#results').append(el('p','接続設定と通信状態を確認してください。','empty'));});
