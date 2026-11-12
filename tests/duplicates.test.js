import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restaurantNameKey,matchingRestaurants} from '../src/duplicates.js';
test('店名は幅・大小文字・空白・中黒をそろえるが読みや支店は同一視しない',()=>{assert.equal(restaurantNameKey(' ＡＢＣ　食 堂・ '),'abc食堂');assert.notEqual(restaurantNameKey('淡淡'),restaurantNameKey('たんたん'));assert.notEqual(restaurantNameKey('定食屋 国分寺店'),restaurantNameKey('定食屋 小金井店'));assert.deepEqual(matchingRestaurants('淡 淡',[{id:1,name:'淡淡',is_published:true},{id:2,name:'淡淡',is_published:false}]).map(r=>r.id),[1]);assert.deepEqual(matchingRestaurants('',[{name:''}]),[]);});
