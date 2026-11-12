// Deliberately conservative: kana/kanji and branch names stay distinct.
export function restaurantNameKey(value){return String(value??'').normalize('NFKC').toLowerCase().replace(/[\s・]/gu,'');}
export function matchingRestaurants(name,rows){const key=restaurantNameKey(name);return key?rows.filter(r=>r.is_published!==false&&restaurantNameKey(r.name)===key):[];}
