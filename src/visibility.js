// Fail closed if a row has no explicit visibility, including in exports.
export function publicRestaurants(rows){return rows.filter(r=>r.is_published===true);}
export function visibilityLabel(r){return r.is_published===true?'公開中':'非公開';}
export function visibilityAction(r){return r.is_published===true?'非公開にする':'再公開する';}
export function filterManagedRestaurants(rows,state,query=''){
 const q=query.normalize('NFKC').toLowerCase().trim();
 return rows.filter(r=>(state==='all'||(state==='published'?r.is_published===true:r.is_published===false))&&r.name.normalize('NFKC').toLowerCase().includes(q));
}
