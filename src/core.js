export const GENRES = ['定食', 'ラーメン', 'うどん・そば', 'カレー', '和食', '寿司・海鮮', '中華', '韓国料理', '洋食', 'イタリアン', '焼肉・肉料理', '居酒屋', 'カフェ', 'パン・サンドイッチ', 'ファストフード', 'スイーツ', 'アジア・エスニック', 'その他'];
export const BUDGETS = [500,700,1000,1500,2000];
export const PURPOSES = ['普段の食事','打ち上げ','新歓','少人数の集まり'];
export const PARKING_LABELS = {yes:'駐輪可',no:'駐輪不可',unknown:'駐輪情報なし'};
// Bicycle figures are a comparison estimate, NOT a verified cycling route.
export function travelMinutes(r, mode='walk') {return Number.isFinite(r.walk_m)&&r.walk_m>0?Math.ceil(r.walk_m/(mode==='bicycle'?200:80)):null;}
export function travelLabel(r,mode='walk') {const n=travelMinutes(r,mode);return n==null?'所要時間未確認':`${mode==='bicycle'?'自転車換算':'徒歩'} 約${n}分`;}
export function budgetLabel(r) {return r.budget_yen==null?'予算未登録':r.budget_yen===2000?'2,000円以上':`${Number(r.budget_yen).toLocaleString()}円程度`;}
export function safeHomepage(value) {
  if(!value)return '';
  if(typeof value!=='string'||value.length>2048)throw new Error('公式サイトのURLを確認してください。');
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||! /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname))throw new Error('公式サイトはHTTPSのURLを入力してください。');
  return u.href;
}
export function restaurantLinks(r) {
  const links=[];
  if(r.google_maps_url){try{parseGoogleUrl(r.google_maps_url);links.push({url:r.google_maps_url,label:'Googleマップ'});}catch{}}
  if(!links.length)links.push({url:'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent([r.name,r.address].filter(Boolean).join(' ')),label:'Googleマップで探す'});
  if(r.official_url){try{links.push({url:safeHomepage(r.official_url),label:'公式サイト'});}catch{}}
  return links;
}
export function parseGoogleUrl(value) {
  if(typeof value!=='string'||value.length>2048)throw new Error('GoogleマップのURLを確認してください。');
  const u = new URL(value);
  if(u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('HTTPSのGoogleマップ共有URLを入力してください。');
  const short = ['maps.app.goo.gl','goo.gl'].includes(u.hostname);
  const long = ['google.com','www.google.com','maps.google.com','google.co.jp','www.google.co.jp','maps.google.co.jp'].includes(u.hostname);
  if (!(short || long) || (long && u.hostname !== 'maps.google.com' && u.hostname !== 'maps.google.co.jp' && !/^\/maps(?:\/|$)/.test(u.pathname))) throw new Error('対応するGoogleマップのURLではありません。');
  if(u.hostname==='goo.gl'&&!/^\/maps\/.+/.test(u.pathname))throw new Error('Googleマップの共有URLを入力してください。');
  const place = u.pathname.match(/\/place\/([^/]+)/);
  const hint = place ? decodeURIComponent(place[1].replace(/\+/g,' ')) : (u.searchParams.get('query') || u.searchParams.get('q') || '');
  return {hint: /^[-\d.,\s]+$/.test(hint) ? '' : hint.slice(0,100), short};
}
export function safeSource(value, kind) {
  if(!value) return '';
  const u = new URL(value);
  if(u.protocol!=='https:' || u.username || u.password || /(^|\.)(google\.[a-z.]+|goo\.gl|gstatic\.com|googleusercontent\.com)$/.test(u.hostname)) throw new Error('情報源にはGoogle以外のHTTPS URLを指定してください。');
  if(kind==='osm' && !/^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/.test(value)) throw new Error('OSMの店舗オブジェクトURLを指定してください。');
  return value;
}
export function validateSubmission(d) {
  if(!d.confirmed) throw new Error('内容確認のチェックが必要です。');
  if(d.website) throw new Error('投稿を受け付けられませんでした。');
  if(!d.name?.trim() || d.name.length>100 || !GENRES.includes(d.genre)) throw new Error('店名・ジャンルを確認してください。');
  if(!Number.isFinite(d.lat)||!Number.isFinite(d.lng)||d.lat<35.67||d.lat>35.74||d.lng<139.45||d.lng>139.53) throw new Error('小金井キャンパス周辺の場所を指定してください。');
  if(d.budget_yen!==null && !BUDGETS.includes(d.budget_yen)) throw new Error('予算は選択肢から選んでください。');
  if(!Object.hasOwn(PARKING_LABELS,d.bicycle_parking)||typeof d.parking_note!=='string'||d.parking_note.length>250) throw new Error('駐輪情報を確認してください。');
  if(!['field','official','osm'].includes(d.source_kind)||typeof d.source_note!=='string'||d.source_note.length>1000)throw new Error('備考は1,000文字以内で入力してください。');
  if(d.submitter_gender!=null&&!['','male','female'].includes(d.submitter_gender))throw new Error('性別は選択肢から選んでください。');
  safeSource(d.source_url,d.source_kind);
  if(d.google_maps_url)parseGoogleUrl(d.google_maps_url);
  if(d.official_url)safeHomepage(d.official_url);
  for(const [key,max] of [['recommended_menu',100],['highlight',100]])if(d[key]!=null&&(typeof d[key]!=='string'||d[key].length>max))throw new Error('おすすめメニューと推しポイントは100文字以内で入力してください。');
  if(d.menu_price_yen!=null&&(!Number.isInteger(d.menu_price_yen)||d.menu_price_yen<0||d.menu_price_yen>100000||!d.recommended_menu?.trim()))throw new Error('メニューの値段はメニュー名と一緒に0〜100,000円の整数で入力してください。');
  if(d.purposes!=null&&(!Array.isArray(d.purposes)||d.purposes.length>4||new Set(d.purposes).size!==d.purposes.length||d.purposes.some(x=>!PURPOSES.includes(x))))throw new Error('目的は選択肢から選んでください。');
  if(d.purpose_note!=null&&(typeof d.purpose_note!=='string'||d.purpose_note.length>250))throw new Error('目的の補足は250文字以内で入力してください。');
  if(d.photo_path&&(!/^[0-9a-f-]{36}\.jpg$/.test(d.photo_path)||d.photo_confirmed!==true))throw new Error('写真の確認事項に同意してください。');
  const paths=d.photo_paths??(d.photo_path?[d.photo_path]:[]);
  if(!Array.isArray(paths)||paths.length>5||new Set(paths).size!==paths.length||paths.some(x=>typeof x!=='string'||!/^[0-9a-f-]{36}\.jpg$/.test(x))||(paths.length&&d.photo_confirmed!==true))throw new Error('写真は最大5枚で、掲載確認が必要です。');
  return d;
}
function matchesTime(r,f){if(!f.distance)return true;const n=travelMinutes(r,f.travel);return n!=null&&(f.distance==='30+'?n>=30:n<=Number(f.distance));}
export function expandPurposes(values){return [...new Set(values.flatMap(x=>x==='打ち上げ・新歓'?['打ち上げ','新歓']:[x]))];}
export function filterRestaurants(rows, f) {
  const q=(f.search||'').normalize('NFKC').toLowerCase().trim();
  return rows.filter(r=>(r.name+r.genre).normalize('NFKC').toLowerCase().includes(q)&&(!f.genre||r.genre===f.genre)&&(!f.price||r.budget_yen===Number(f.price))&&(!f.purpose||r.purposes?.includes(f.purpose))&&(!f.parking||r.bicycle_parking===f.parking)&&matchesTime(r,f)).sort((a,b)=>f.sort==='price'?(a.budget_yen??Infinity)-(b.budget_yen??Infinity):a.walk_m-b.walk_m);
}
export const demoRestaurants = [
  {id:'demo-1',purposes:['普段の食事','少人数の集まり'],purpose_note:'2〜4人での食事（架空の設定）',recommended_menu:'から揚げ定食（表示例）',menu_price_yen:700,highlight:'ごはん大盛り無料（架空の設定）',name:'サンプル食堂 けやき',genre:'定食',budget_yen:700,bicycle_parking:'yes',parking_note:'店舗前に駐輪スペース（架空の設定）',lat:35.7035,lng:139.492,walk_m:560,address:'架空の店舗・デモデータ',source_kind:'field',source_note:'動作確認用の架空店舗です。実在しません。'},
  {id:'demo-2',purposes:['打ち上げ','新歓'],purpose_note:'団体予約の確認用サンプル。実際の受入情報ではありません。',name:'サンプル中華 ひだまり',genre:'ラーメン',budget_yen:1000,bicycle_parking:'no',parking_note:'専用の駐輪場なし（架空の設定）',lat:35.7005,lng:139.485,walk_m:1120,address:'架空の店舗・デモデータ',source_kind:'field',source_note:'動作確認用の架空店舗です。実在しません。'},
  {id:'demo-3',purposes:['普段の食事'],name:'サンプル喫茶 こもれび',genre:'カフェ',budget_yen:700,bicycle_parking:'unknown',parking_note:'',lat:35.709,lng:139.499,walk_m:960,address:'架空の店舗・デモデータ',source_kind:'field',source_note:'動作確認用の架空店舗です。実在しません。'},
  {id:'demo-4',purposes:['打ち上げ'],name:'サンプルカレー 日々',genre:'カレー',budget_yen:1500,bicycle_parking:'yes',parking_note:'店舗横に駐輪スペース（架空の設定）',lat:35.698,lng:139.495,walk_m:1680,address:'架空の店舗・デモデータ',source_kind:'field',source_note:'動作確認用の架空店舗です。実在しません。'},
];
