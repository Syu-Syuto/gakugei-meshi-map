import {createAdminWorkflows} from './admin-workflows.js?v=9';
import {hasMapLocation} from './workflow-core.js';
import {publicRestaurants,visibilityLabel,visibilityAction,filterManagedRestaurants} from './visibility.js?v=7';
import {preparePhoto,MAX_PHOTOS} from './photos.js?v=form-6';
import {config} from '../config.js';
import {parseGoogleUrl,validateSubmission,filterRestaurants,demoRestaurants,safeSource,travelLabel,budgetLabel,PARKING_LABELS,restaurantLinks,expandPurposes} from './core.js?v=workflow-9';
const $=s=>document.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const demo=!config.supabaseUrl || !config.supabasePublishableKey;
let photos=[],photoProcessing=Promise.resolve(),photoBusy=false;
let db,rows=[],pending=[],map,markers,selectedId,session,widgetIds={},tokens={};
const form=$('#submission-form');
let managedRows=[],adminView='pending';
const demoVisibility=new Map(),demoEdits=new Map(),demoAcks=new Map();
let contributionTarget=null;
function demoAck(key,d){const missing=[];if(d.lat==null)missing.push('緯度・経度');if(d.walk_m==null)missing.push('徒歩距離');if(!d.address)missing.push('住所');if(d.budget_yen==null)missing.push('予算');if(!d.purposes?.length)missing.push('利用目的');const fingerprint=JSON.stringify(d),old=demoAcks.get(key),attempt=old?.fingerprint===fingerprint?old.attempt+1:1;demoAcks.set(key,{fingerprint,attempt});return {ready:!missing.length||attempt>=3,attempt,missing};}
function allDemoRestaurants(){return [...demoRestaurants,...pending.filter(p=>p.status==='approved'&&p.submission_kind!=='addition').map(p=>({...p,id:p.id+'-published'}))].map(r=>({...r,...demoEdits.get(r.id),is_published:demoVisibility.get(r.id)??true}));}
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
  if(!tokens.submit){$('#captcha-submit').scrollIntoView({block:'center'});throw new Error('人間確認を完了してから送信してください。');}
  const result=await db.auth.signInAnonymously({options:{captchaToken:tokens.submit}});resetCaptcha('submit');if(result.error)throw result.error;return result.data.session;
}
function openSubmission(target=null){
 if(contributionTarget?.id!==target?.id){form.reset();photos.forEach(x=>{if(x.url)URL.revokeObjectURL(x.url);});photos=[];renderPhotoPreviews();setStatus('#submit-status','');}
 contributionTarget=target;document.querySelectorAll('[data-new-only]').forEach(section=>{section.hidden=!!target;section.querySelectorAll('input,select,textarea').forEach(input=>input.disabled=!!target);});
 $('#submit-title').textContent=target?'このお店に情報を追加':'お店を追加する';$('#contribution-target').hidden=!target;$('#contribution-target').textContent=target?target.name:'';
 $('#submission-steps').textContent=target?'写真・費用・おすすめなど、分かる情報を教えてください。掲載前に管理者が確認します。':'店名・ジャンル・利用目的を入力してください。お店の場所は掲載前に管理者が確認します。';
 updateOtherPurpose();$('#submit-dialog').showModal();captcha('submit').catch(e=>setStatus('#submit-status',e.message));
}
$('#open-submit').onclick=()=>openSubmission();$('#open-submit-bottom').onclick=()=>openSubmission();
function updateOtherPurpose(){const selected=$('#purpose-other-check').checked;$('#purpose-other-label').hidden=!selected;$('#purpose-other').required=selected;}
$('#purpose-other-check').onchange=updateOtherPurpose;
function initMap(){
  if(!window.L){$('#map').append(el('p','地図を読み込めませんでした。一覧と投稿はそのまま利用できます。','empty'));return;}
  map=L.map('map',{scrollWheelZoom:false}).setView(config.campus,15);
  L.tileLayer(config.tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',detectRetina:false}).addTo(map);
  L.marker(config.campus,{icon:L.divIcon({html:'<span class="pin campus-pin">学</span>',className:'',iconSize:[30,30]})}).addTo(map).bindPopup('東京学芸大学 小金井キャンパス（地図中心の目安）');
  markers=L.layerGroup().addTo(map);
}
function getFilters(){return Object.fromEntries(['search','genre','price','travel','distance','purpose','parking','sort'].map(k=>[k,$('#'+k).value]));}
function updateTravelHelp(){setStatus('#travel-help',$('#travel').value==='bicycle'?'自転車の目安：徒歩経路の距離を200m/分で換算。走行可能な経路・信号待ち・駐輪時間は未確認です。':'徒歩の目安：確認した歩行経路の距離を80m/分で換算。掲載範囲は徒歩約25分以内です。');}
$('#travel').addEventListener('change',updateTravelHelp);
function render(){
  if(demo)setStatus('#mode','動作確認用のサンプルを表示しています。実在するお店ではありません。');
  const shown=filterRestaurants(rows,getFilters());$('#count').textContent=shown.length;$('#results').replaceChildren();markers?.clearLayers();
  if(!shown.length)$('#results').append(el('p',rows.length?'条件に合うお店がありません。絞り込み条件を変えてみてください。':'掲載準備中です。おすすめのお店があれば「お店を追加」から教えてください。','empty'));
  shown.forEach((r,i)=>{
    const b=el('button',undefined,'card'+(selectedId===r.id?' selected':''));b.type='button';
    const top=el('div',undefined,'card-top');top.append(el('span',r.genre,'tag'),el('span',travelLabel(r,$('#travel').value),'walk'));
    const bottom=el('div',undefined,'card-bottom');bottom.append(el('strong',budgetLabel(r)),el('span','詳細'));
    b.append(el('span',String(i+1).padStart(2,'0'),'card-index'),top,el('h3',r.name),el('p',(r.address||'住所未登録')+' · '+PARKING_LABELS[r.bicycle_parking??'unknown'],'address'),bottom);b.onclick=()=>showDetail(r);$('#results').append(b);
    if(markers&&hasMapLocation(r)){const m=L.marker([r.lat,r.lng],{icon:L.divIcon({html:`<span class="pin">${i+1}</span>`,className:'',iconSize:[30,30]})}).addTo(markers);m.bindTooltip(r.name);m.on('click',()=>showDetail(r));}
  });
}
document.addEventListener('export-restaurants',()=>{
  const data={attribution:'© OpenStreetMap contributors and Gakugei Meshi Map contributors',license:'ODbL-1.0',license_url:'https://opendatacommons.org/licenses/odbl/1-0/',demo,exported_at:new Date().toISOString(),restaurants:rows.map(({_demo_photo_url,_demo_photo_urls,...r})=>r)};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=demo?'gakugei-meshi-DEMO.json':'gakugei-meshi-ODbL.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function appendPurposes(container,r){if(!r.purposes?.length)return;const section=el('section',undefined,'recommendation');section.append(el('h3','向いている目的'),el('p',r.purposes.join('・')));if(r.purpose_other)section.append(el('p','その他：'+r.purpose_other));if(r.purpose_note)section.append(el('p',r.purpose_note));section.append(el('p','団体利用の人数・予約条件はお店にご確認ください。','help'));container.append(section);}
async function appendPhoto(container,r){
 const paths=r.photo_paths?.length?r.photo_paths:(r.photo_path?[r.photo_path]:[]),urls=r._demo_photo_urls??(r._demo_photo_url?[r._demo_photo_url]:[]);
 if(!paths.length&&!urls.length)return;const gallery=el('div',undefined,'photo-gallery');container.append(gallery);
 for(let i=0;i<Math.max(paths.length,urls.length);i++){
  const figure=el('figure',undefined,'store-photo'),img=el('img'),caption=el('figcaption',`投稿写真 ${i+1}`);img.alt=r.name+'への投稿写真 '+(i+1);img.loading='lazy';figure.append(img,caption);gallery.append(figure);
  try{if(demo){img.src=urls[i];}else{const {data,error}=await db.storage.from('restaurant-photos').createSignedUrl(paths[i],300);if(error)throw error;img.src=data.signedUrl;}img.onerror=()=>{img.hidden=true;caption.textContent='写真を読み込めませんでした。開き直してください。';};}catch{img.hidden=true;caption.textContent='写真を読み込めませんでした。';}
 }
}
function appendRecommendation(container,r){
 if(!r.recommended_menu&&!r.highlight&&!r.submitter_gender)return;
 const section=el('section',undefined,'recommendation');section.append(el('h3','投稿者のおすすめ'));if(r.submitter_gender)section.append(el('p','投稿者：'+({male:'男性',female:'女性'}[r.submitter_gender]||'回答なし')+'（任意回答）','help'));
 if(r.recommended_menu){section.append(el('p',r.recommended_menu+(r.menu_price_yen==null?'':` · ${Number(r.menu_price_yen).toLocaleString()}円`)));}
 if(r.highlight)section.append(el('p',r.highlight));
 section.append(el('p','投稿時点の情報です。現在のメニュー・価格はお店でご確認ください。','help'));container.append(section);
}
function showDetail(r){selectedId=r.id;render();if(hasMapLocation(r))map?.panTo([r.lat,r.lng]);$('#detail-title').textContent=r.name;const c=$('#detail-content');c.replaceChildren();c.append(el('p',`${r.genre} · ${budgetLabel(r)} · ${travelLabel(r,$('#travel').value)}`),el('p',r.address||''),el('p',PARKING_LABELS[r.bicycle_parking??'unknown']+(r.parking_note?'：'+r.parking_note:'')),el('p',r.source_note||''));appendPurposes(c,r);workflows.publicExtras(r,c);const links=el('nav',undefined,'store-links');links.setAttribute('aria-label','店舗の外部リンク');for(const link of restaurantLinks(r))links.append(externalLink(link.url,link.label+' ↗'));c.append(links);if(!r.google_maps_url)c.append(el('p','Googleマップの店舗URLは未登録のため、店名で検索します。','help'));if(r.source_url){try{safeSource(r.source_url,r.source_kind);c.append(externalLink(r.source_url,'掲載情報の出典 ↗'));}catch{}}$('#detail-dialog').showModal();}
['search','genre','price','travel','distance','purpose','parking','sort'].forEach(k=>$('#'+k).addEventListener(k==='search'?'input':'change',render));
$('#reset').onclick=()=>{$('#search').value='';$('#genre').value='';$('#price').value='';$('#distance').value='';$('#travel').value='walk';$('#parking').value='';$('#purpose').value='';updateTravelHelp();$('#sort').value='distance';render();};
async function load(){if(demo){rows=publicRestaurants(allDemoRestaurants());}else{const result=await db.from('restaurants').select('*').eq('is_published',true).order('walk_m');if(result.error)throw result.error;rows=publicRestaurants(result.data);}if(selectedId&&!rows.some(r=>r.id===selectedId)){$('#detail-dialog').close();$('#detail-content').replaceChildren();selectedId=null;}render();}
$('#google-url').addEventListener('change',()=>{try{if($('#google-url').value)parseGoogleUrl($('#google-url').value);setStatus('#url-status','リンクを確認しました。店名は下の欄へご自身で入力してください。');}catch{setStatus('#url-status','Googleマップの共有URLを貼ってください。Appleの「マップ」のリンクには対応していません。');}});
function renderPhotoPreviews(){
 const target=$('#photo-previews');target.replaceChildren();
 for(const photo of photos){const box=el('figure'),caption=el('figcaption',photo.name),remove=el('button','削除','quiet');remove.type='button';remove.disabled=photoBusy;remove.setAttribute('aria-label',photo.name+'を削除');remove.onclick=()=>{photos=photos.filter(x=>x!==photo);if(photo.url)URL.revokeObjectURL(photo.url);renderPhotoPreviews();};if(photo.url){const img=el('img');img.src=photo.url;img.alt=photo.name+'のプレビュー';box.append(img);}if(photo.error)box.append(el('p',photo.error,'photo-error'));box.append(caption,remove);target.append(box);}
 setStatus('#photo-status',photoBusy?'写真を1枚ずつ準備しています…':photos.length?`${photos.length}枚選択中。追加選択できます。承認までは非公開です。`:'');
}
$('#photo').addEventListener('change',()=>{
 const files=[...$('#photo').files];$('#photo').value='';if(photos.length+files.length>MAX_PHOTOS){setStatus('#photo-status','写真は最大5枚です。不要な写真を削除してから選び直してください。');return;}
 photoBusy=true;$('#photo').disabled=true;
 photoProcessing=(async()=>{try{for(const file of files){const photo={name:file.name};photos.push(photo);renderPhotoPreviews();try{photo.blob=await preparePhoto(file);photo.url=URL.createObjectURL(photo.blob);}catch(e){photo.error=e.message;}renderPhotoPreviews();}}finally{photoBusy=false;$('#photo').disabled=false;renderPhotoPreviews();}})();
});
form.addEventListener('submit',e=>{e.preventDefault();busy(form.querySelector('[type=submit]'),async()=>{
 await photoProcessing;if(photos.some(x=>x.error))throw new Error('読み込めない写真を削除するか、選び直してください。');
 const formData=new FormData(form),d={...(contributionTarget||{}),...Object.fromEntries(formData)};if(contributionTarget)for(const key of ['name','genre','address','google_maps_url','official_url','source_url','source_kind','source_note','bicycle_parking','parking_note'])d[key]=contributionTarget[key]??'';d.target_restaurant_id=contributionTarget?.id||null;d.purposes=expandPurposes(formData.getAll('purposes'));d.purpose_note=d.purpose_note.trim();d.purpose_other=d.purposes.includes('その他')?d.purpose_other.trim():'';d.photo_confirmed=!!d.photo_confirmed;d.photo_paths=[];d.photo_path='';if(photos.length&&!d.photo_confirmed)throw new Error('写真の確認事項に同意してください。');
 d.budget_yen=d.budget_yen===''?null:Number(d.budget_yen);d.menu_price_yen=d.menu_price_yen===''?null:Number(d.menu_price_yen);d.recommended_menu=d.recommended_menu.trim();d.highlight=d.highlight.trim();d.confirmed=!!d.confirmed;d.google_maps_url=d.google_maps_url.trim();d.official_url=d.official_url.trim();d.source_url=d.source_url.trim();if(!d.source_url)d.source_kind='field';validateSubmission(d);delete d.website;
 if(demo){d.photo_paths=photos.map(()=>crypto.randomUUID()+'.jpg');d.photo_path=d.photo_paths[0]||'';d._demo_photo_urls=photos.map(x=>URL.createObjectURL(x.blob));pending.push({...d,submission_kind:contributionTarget?'addition':'new',target_restaurant_id:contributionTarget?.id,id:crypto.randomUUID(),status:'pending',created_at:new Date().toISOString()});}
 else{await ensureSession();for(let i=0;i<photos.length;i++){const photo=photos[i];
  if(photo.path&&Date.now()-photo.reservedAt>3500000){photo.path=null;photo.uploaded=false;}
  if(!photo.path){const slot=await db.rpc('reserve_restaurant_photo');if(slot.error)throw slot.error;photo.path=slot.data;photo.reservedAt=Date.now();}
  if(!photo.uploaded){setStatus('#submit-status',`写真を送信しています（${i+1}/${photos.length}）…`);const upload=await db.storage.from('restaurant-photos').upload(photo.path,photo.blob,{contentType:'image/jpeg',upsert:false});if(upload.error)throw new Error('写真の送信に失敗しました。入力は残っています。もう一度送信してください。');photo.uploaded=true;}
  d.photo_paths.push(photo.path);
 }d.photo_path=d.photo_paths[0]||'';validateSubmission(d);const {error}=await db.rpc('submit_restaurant',{p:d});if(error)throw error;}
 form.reset();updateOtherPurpose();photos.forEach(x=>{if(x.url)URL.revokeObjectURL(x.url);});photos=[];renderPhotoPreviews();setStatus('#submit-status',demo?'デモの審査待ちに追加しました。「管理」から承認を試せます。再読み込みすると消えます。':'審査に送りました。承認されるまで公開されません。');$('#submit-status').scrollIntoView({block:'center'});
},'#submit-status');});
async function adminCheck(){if(demo)return true;const {data:sessionData,error:sessionError}=await db.auth.getSession();if(sessionError)throw sessionError;if(!sessionData.session)return false;const {data,error}=await db.rpc('is_admin');if(error)throw error;return data===true;}
async function showQueue(){
  if(!await adminCheck())throw new Error('管理者権限がありません。');
  $('#login-form').hidden=true;$('#admin-tools').hidden=false;$('#queue').replaceChildren();
  let queue=pending.filter(p=>p.status==='pending');if(!demo){const r=await db.from('submissions').select('*').eq('status','pending').order('created_at');if(r.error)throw r.error;queue=r.data;}
  if(!queue.length)$('#queue').append(el('p','審査待ちの投稿はありません。','empty'));
  for(const item of queue){const d=demo?item:item.payload,box=el('div',undefined,'queue-item');box.append(el('h3',d.name),el('p',`${d.genre} / ${budgetLabel(d)}`),el('p',d.address||''),el('p',(PARKING_LABELS[d.bicycle_parking??'unknown'])+'：'+(d.parking_note||'補足なし')),el('p','備考：'+(d.source_note||'なし')));
    appendPurposes(box,d);appendRecommendation(box,d);appendPhoto(box,d);const links=el('nav',undefined,'store-links');for(const link of restaurantLinks(d))links.append(externalLink(link.url,link.label+' ↗'));box.append(links);if(d.source_url){try{safeSource(d.source_url,d.source_kind);box.append(externalLink(d.source_url,'独立情報源を開く ↗'));}catch{box.append(el('p','情報源URLを再確認してください。'));}}
    if(Number.isFinite(d.lat)&&Number.isFinite(d.lng))box.append(externalLink(`https://www.openstreetmap.org/?mlat=${encodeURIComponent(d.lat)}&mlon=${encodeURIComponent(d.lng)}#map=18/${encodeURIComponent(d.lat)}/${encodeURIComponent(d.lng)}`,'位置をOSMで確認 ↗'));
    $('#queue').append(box);
    await workflows.review(item,d,box,(approve,values)=>{const result=approve&&item.submission_kind!=='addition'?demoAck(item.id,{...d,...values}):{ready:true};if(!result.ready)return result;Object.assign(item,values,{status:approve?'approved':'rejected'});return result;});
  }
  await refreshManagedRestaurants();
}
$('#open-admin').onclick=async()=>{$('#admin-dialog').showModal();try{if(demo){setStatus('#admin-status','デモ用の審査画面です。実際の管理者権限はSupabase側で検証します。');await showQueue();}else{await captcha('admin');if(await adminCheck())await showQueue();}}catch(e){setStatus('#admin-status',e.message);}};
$('#login-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{if(!tokens.admin)throw new Error('人間確認を完了してください。');const f=new FormData(e.target);const {error}=await db.auth.signInWithPassword({email:f.get('email'),password:f.get('password'),options:{captchaToken:tokens.admin}});resetCaptcha('admin');if(error)throw error;e.target.reset();await showQueue();},'#admin-status');};
$('#logout').onclick=async()=>{if(!demo)await db.auth.signOut();managedRows=[];$('#queue').replaceChildren();$('#managed-restaurants').replaceChildren();$('#detail-dialog').close();$('#detail-content').replaceChildren();$('#admin-tools').hidden=true;$('#login-form').hidden=false;await load();setStatus('#admin-status','ログアウトしました。');};
$('#refresh-queue').onclick=e=>busy(e.currentTarget,async()=>{await showQueue();await load();},'#admin-status');
function selectAdminView(view){adminView=view;$('#pending-panel').hidden=view!=='pending';$('#registered-panel').hidden=view!=='registered';$('#view-pending').setAttribute('aria-pressed',String(view==='pending'));$('#view-registered').setAttribute('aria-pressed',String(view==='registered'));}
$('#view-pending').onclick=()=>selectAdminView('pending');
$('#view-registered').onclick=()=>selectAdminView('registered');
async function refreshManagedRestaurants(){
 if(demo){managedRows=allDemoRestaurants();}else{const {data,error}=await db.from('restaurants').select('*').order('name');if(error)throw error;managedRows=data;}
 renderManagedRestaurants();selectAdminView(adminView);
}
function renderManagedRestaurants(){
 const container=$('#managed-restaurants');container.replaceChildren();const shown=filterManagedRestaurants(managedRows,$('#managed-state').value,$('#managed-search').value);
 setStatus('#managed-count',`${shown.length}件（公開中 ${managedRows.filter(r=>r.is_published).length}件・非公開 ${managedRows.filter(r=>!r.is_published).length}件）`);
 if(!shown.length){container.append(el('p',managedRows.length?'条件に合う店舗はありません。':'登録済みの店舗はまだありません。','empty'));return;}
 for(const r of shown){
  const box=el('article',undefined,'managed-restaurant'),heading=el('div',undefined,'managed-heading');heading.append(el('h4',r.name),el('span',visibilityLabel(r),r.is_published?'visibility-public':'visibility-hidden'));box.append(heading,el('p',`${r.genre} · ${budgetLabel(r)}`),el('p',r.address||'住所未登録'));
  const actions=el('div',undefined,'managed-actions'),details=el('button','店舗の内容を確認','quiet'),toggle=el('button',visibilityAction(r),'outline');details.type=toggle.type='button';details.onclick=()=>showDetail(r);toggle.setAttribute('aria-label',r.name+'を'+visibilityAction(r));
  const confirmation=el('div',undefined,'visibility-confirmation');confirmation.hidden=true;const explain=el('p'),apply=el('button','変更する','primary'),cancel=el('button','キャンセル','quiet');apply.type=cancel.type='button';confirmation.append(explain,apply,cancel);
  toggle.onclick=()=>{explain.textContent=r.is_published?`${r.name}を非公開にしますか？ 一覧・地図・店舗データから表示を外します。発行済みの写真リンクは最長5分残る場合があります。`:`${r.name}を再公開しますか？ 店舗情報と写真が再び一般公開されます。`;confirmation.hidden=false;toggle.hidden=true;apply.focus();};
  cancel.onclick=()=>{confirmation.hidden=true;toggle.hidden=false;toggle.focus();};
  apply.onclick=()=>busy(apply,async()=>{
   cancel.disabled=true;toggle.disabled=true;try{const target=!r.is_published;
    if(demo){demoVisibility.set(r.id,target);}else{const {error}=await db.rpc('set_restaurant_visibility',{restaurant_id:r.id,published:target,expected_published:r.is_published});if(error)throw error;}
    await load();await refreshManagedRestaurants();setStatus('#admin-status',r.name+(target?'を再公開しました。':'を非公開にしました。'));$('#admin-status').scrollIntoView({block:'nearest'});
   }finally{cancel.disabled=false;toggle.disabled=false;}
  },'#admin-status');
  actions.append(details,toggle);box.append(actions,confirmation);container.append(box);workflows.editRestaurant(r,box,d=>{const result=demoAck(r.id,d);if(result.ready)demoEdits.set(r.id,d);return result;});
 }
}
$('#managed-search').oninput=renderManagedRestaurants;
$('#managed-state').onchange=renderManagedRestaurants;
function showPasswordRecovery(){
  $('#login-form').hidden=true;$('#admin-tools').hidden=true;
  let recovery=$('#password-recovery');if(recovery)return;
  recovery=el('form');recovery.id='password-recovery';
  const label=el('label','新しい管理用パスワード');const password=el('input');password.type='password';password.required=true;password.minLength=12;password.autocomplete='new-password';label.append(password);
  const confirmLabel=el('label','もう一度入力');const confirmation=el('input');confirmation.type='password';confirmation.required=true;confirmation.autocomplete='new-password';confirmLabel.append(confirmation);
  const save=el('button','パスワードを保存','primary');save.type='submit';recovery.append(el('p','12文字以上のパスワードを設定し、安全な場所に保存してください。'),label,confirmLabel,save);$('#admin-status').before(recovery);
  recovery.onsubmit=e=>{e.preventDefault();busy(save,async()=>{if(password.value!==confirmation.value)throw new Error('パスワードが一致していません。');const {error}=await db.auth.updateUser({password:password.value});if(error)throw error;recovery.reset();recovery.remove();setStatus('#admin-status','パスワードを更新しました。');await showQueue();},'#admin-status');};
  if(!$('#admin-dialog').open)$('#admin-dialog').showModal();setStatus('#admin-status','メールの本人確認が完了しました。新しいパスワードを設定してください。');
}
async function start(){
  setStatus('#mode',demo?'動作確認用のサンプルを表示しています。実在するお店ではありません。':'追加されたお店は、内容を確認してから掲載します。');
  initMap();if(!demo){const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');db=createClient(config.supabaseUrl,config.supabasePublishableKey);db.auth.onAuthStateChange(event=>{if(event==='PASSWORD_RECOVERY')showPasswordRecovery();});}
  await load();
}
const workflows=createAdminWorkflows({getDb:()=>db,demo,refresh:async()=>{await showQueue();await load();},appendPhoto,appendRecommendation,getDemoExtras:r=>{const additions=pending.filter(p=>p.status==='approved'&&p.submission_kind==='addition'&&p.target_restaurant_id===r.id);if(!additions.length)return {groups:[],posts:[]};const posts=[r,...additions].map(p=>({...p,group_id:p.recommended_menu||null}));const groups=[...new Set(posts.map(p=>p.recommended_menu).filter(Boolean))].map(name=>({id:name,name,count:1}));return {groups,posts,has_managed_posts:true};},openAddition:r=>{$('#detail-dialog').close();openSubmission(r);}});
start().catch(e=>{setStatus('#mode','読み込みに失敗しました：'+e.message);$('#results').append(el('p','接続設定と通信状態を確認してください。','empty'));});
