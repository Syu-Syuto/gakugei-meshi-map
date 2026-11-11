import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicRestaurants,filterManagedRestaurants,visibilityAction,visibilityLabel} from '../src/visibility.js';
const rows=[{id:'a',name:'公開の食堂',is_published:true},{id:'b',name:'非公開のカフェ',is_published:false},{id:'c',name:'未定義'}];
test('一般表示・エクスポート対象には明示的な公開店舗だけを含む',()=>{
 assert.deepEqual(publicRestaurants(rows).map(r=>r.id),['a']);
 assert.equal(rows.length,3);
});
test('管理一覧では公開中・非公開を店名と併せて絞り込める',()=>{
 assert.deepEqual(filterManagedRestaurants(rows,'hidden').map(r=>r.id),['b']);
 assert.deepEqual(filterManagedRestaurants(rows,'all','カフェ').map(r=>r.id),['b']);
 assert.equal(filterManagedRestaurants(rows,'published','カフェ').length,0);
});
test('非公開から再公開しても内容を保持し、一般向けの表示対象に戻る',()=>{
 const hidden={...rows[0],is_published:false};assert.equal(visibilityAction(hidden),'再公開する');assert.equal(visibilityLabel(hidden),'非公開');assert.equal(publicRestaurants([hidden]).length,0);
 const restored={...hidden,is_published:true};assert.equal(visibilityAction(restored),'非公開にする');assert.equal(visibilityLabel(restored),'公開中');assert.equal(publicRestaurants([restored])[0].name,rows[0].name);
});
