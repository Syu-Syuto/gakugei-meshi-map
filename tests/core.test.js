import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePhotoFile} from '../src/photos.js';
import {parseGoogleUrl,validateSubmission,filterRestaurants,demoRestaurants,safeSource,travelMinutes,travelLabel,budgetLabel,restaurantLinks,safeHomepage} from '../src/core.js';
test('URLの店名はヒントのみ。座標を店舗データへ移さない',()=>{
 const p=parseGoogleUrl('https://www.google.com/maps/place/%E9%A3%9F%E5%A0%82+ABC/@35.7,139.49,16z');
 assert.deepEqual(p,{hint:'食堂 ABC',short:false});assert.equal('lat' in p,false);
 assert.equal(parseGoogleUrl('https://maps.google.com/?q=35.7,139.49').hint,'');
});
test('短縮URL・識別子のみのURLは手入力に進める',()=>{
 assert.deepEqual(parseGoogleUrl('https://maps.app.goo.gl/abc'),{hint:'',short:true});
 assert.equal(parseGoogleUrl('https://www.google.com/maps?cid=123').hint,'');
});
test('偽装ホスト・資格情報付き・非HTTPS URLを拒否',()=>{
 for(const u of ['https://google.com.evil.example/maps/place/A','javascript:alert(1)','http://www.google.com/maps','https://google.com@evil.example/maps','https://user@www.google.com/maps','https://www.google.com/search?q=A','https://www.google.com:444/maps'])assert.throws(()=>parseGoogleUrl(u));
});
test('情報源URLはGoogle転載と危険なスキームを拒否',()=>{
 for(const u of ['javascript:alert(1)','https://maps.google.co.jp/maps','https://maps.app.goo.gl/a','https://goo.gl/maps/a','https://www.google.com/maps','https://user@example.com'])assert.throws(()=>safeSource(u,'official'));
 assert.equal(safeSource('https://example.com/menu','official'),'https://example.com/menu');
 assert.equal(safeSource('https://www.openstreetmap.org/node/123','osm'),'https://www.openstreetmap.org/node/123');
 assert.throws(()=>safeSource('https://www.openstreetmap.org.evil.example/node/123','osm'));
});
const valid={name:'テスト店',genre:'定食',lat:35.704,lng:139.49,budget_yen:null,bicycle_parking:'unknown',parking_note:'',source_kind:'field',source_url:'',source_note:'現地で確認しました',confirmed:true};
test('手入力でも確認と独立情報源が必要。範囲外・不正な予算を拒否',()=>{
 assert.equal(validateSubmission({...valid}).name,'テスト店');
 for(const patch of [{confirmed:false},{lat:NaN},{lat:35.8},{lng:140},{budget_yen:800},{budget_yen:-1},{bicycle_parking:'maybe'},{parking_note:'a'.repeat(251)},{source_note:''},{source_kind:'google'},{source_kind:'official',source_url:''},{website:'spam'}])assert.throws(()=>validateSubmission({...valid,...patch}));
});
test('店名・ジャンル・価格・実歩行距離を併用して検索',()=>{
 assert.equal(filterRestaurants(demoRestaurants,{search:'サンプル',genre:'定食',price:'700',distance:'10'}).length,1);
 assert.equal(filterRestaurants(demoRestaurants,{genre:'カレー',distance:'20'}).length,0);
 assert.equal(filterRestaurants(demoRestaurants,{search:'不存在',distance:'25'}).length,0);
 assert.deepEqual(filterRestaurants(demoRestaurants,{price:'700',distance:'25'}).map(r=>r.genre),['定食','カフェ']);
});
test('価格不明は予算指定時に除外。並び替えは元配列を変えない',()=>{
 const rows=[{...demoRestaurants[0],budget_yen:null},demoRestaurants[2]];
 assert.equal(filterRestaurants(rows,{price:'700',distance:'25'}).length,1);
 assert.equal(filterRestaurants(rows,{sort:'price',distance:'25'})[0].genre,'カフェ');
 assert.equal(rows[0].budget_yen,null);
});
test('予算は上限ではなく目安の区分として一致させる',()=>{
 assert.equal(filterRestaurants(demoRestaurants,{price:'1000',distance:'25'}).length,1);
 assert.equal(budgetLabel(demoRestaurants[1]),'1,000円程度');
 for(const budget_yen of [700,1000,1500,null])assert.doesNotThrow(()=>validateSubmission({...valid,budget_yen}));
});
test('徒歩と自転車換算で時間を絞り込み、端数は切り上げる',()=>{
 const r={...demoRestaurants[0],walk_m:1001};
 assert.equal(travelMinutes(r,'walk'),13);assert.equal(travelMinutes(r,'bicycle'),6);
 assert.equal(filterRestaurants([r],{travel:'bicycle',distance:'5'}).length,0);
 assert.equal(filterRestaurants([r],{travel:'bicycle',distance:'6'}).length,1);
 assert.equal(filterRestaurants([r],{travel:'walk',distance:'6'}).length,0);
 assert.equal(travelLabel(r,'bicycle'),'自転車換算 約6分');
});
test('駐輪情報なしを駐輪可として扱わず、予算と自転車時間を併用できる',()=>{
 const result=filterRestaurants(demoRestaurants,{parking:'yes',price:'700',travel:'bicycle',distance:'5'});
 assert.deepEqual(result.map(r=>r.id),['demo-1']);
 assert.equal(filterRestaurants(demoRestaurants,{parking:'unknown',distance:'25'})[0].id,'demo-3');
 assert.equal(filterRestaurants(demoRestaurants,{parking:'no',distance:'25'})[0].id,'demo-2');
});
test('登録済み店舗リンクを使い、未登録なら店名検索と区別する',()=>{
 const links=restaurantLinks({name:'テスト店',address:'小金井市',google_maps_url:'https://maps.app.goo.gl/test',official_url:'https://example.com/menu'});
 assert.deepEqual(links.map(x=>x.label),['Googleマップ','公式サイト']);
 assert.equal(links[0].url,'https://maps.app.goo.gl/test');
 const fallback=restaurantLinks({name:'店名 A&B',address:'小金井市'});
 assert.equal(fallback.length,1);assert.equal(fallback[0].label,'Googleマップで探す');
 assert.equal(new URL(fallback[0].url).searchParams.get('query'),'店名 A&B 小金井市');
});
test('危険な店舗リンクを拒否し、リンクを勝手に公式扱いしない',()=>{
 for(const u of ['javascript:alert(1)','http://example.com','https://user:pw@example.com','https://example.com:444/a'])assert.throws(()=>safeHomepage(u));
 for(const google_maps_url of ['https://google.com.evil.example/maps','https://goo.gl/not-maps','javascript:alert(1)'])assert.throws(()=>validateSubmission({...valid,google_maps_url}));
 assert.equal(restaurantLinks({name:'test',official_url:'javascript:alert(1)'}).length,1);
});
test('おすすめメニュー価格は予算区分と別。空欄可、価格だけ・長文は拒否',()=>{
 assert.doesNotThrow(()=>validateSubmission({...valid,recommended_menu:'から揚げ定食',menu_price_yen:850,highlight:'ごはん大盛り無料'}));
 for(const patch of [{menu_price_yen:850,recommended_menu:''},{recommended_menu:'定食',menu_price_yen:-1},{recommended_menu:'定食',menu_price_yen:850.5},{recommended_menu:'a'.repeat(101)},{highlight:'a'.repeat(101)}])assert.throws(()=>validateSubmission({...valid,...patch}));
});
test('打ち上げ・新歓で絞り込める。複数目的はそれぞれ一致する',()=>{
 assert.deepEqual(filterRestaurants(demoRestaurants,{purpose:'新歓',distance:'25'}).map(r=>r.id),['demo-2']);
 assert.deepEqual(filterRestaurants(demoRestaurants,{purpose:'打ち上げ',distance:'25'}).map(r=>r.id),['demo-2','demo-4']);
 assert.equal(filterRestaurants(demoRestaurants,{purpose:'新歓',parking:'yes',distance:'25'}).length,0);
 for(const purposes of [['打ち上げ','新歓'],[]])assert.doesNotThrow(()=>validateSubmission({...valid,purposes}));
 for(const purposes of [['その他'],['新歓','新歓'],'新歓'])assert.throws(()=>validateSubmission({...valid,purposes}));
});
test('写真の形式と容量、写真の掲載確認を検証する',()=>{
 assert.doesNotThrow(()=>validatePhotoFile({type:'image/jpeg',size:1024}));
 for(const file of [{type:'image/svg+xml',size:10},{type:'image/heic',size:10},{type:'image/jpeg',size:0},{type:'image/png',size:11*1024*1024}])assert.throws(()=>validatePhotoFile(file));
 assert.throws(()=>validateSubmission({...valid,photo_path:'../../bad.jpg',photo_confirmed:true}));
 assert.throws(()=>validateSubmission({...valid,photo_path:'10000000-0000-0000-0000-000000000001.jpg',photo_confirmed:false}));
});
