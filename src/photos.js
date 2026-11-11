export const MAX_ORIGINAL_BYTES=10*1024*1024;
export const MAX_PHOTOS=5;
export function isHeicFile(file){return ['image/heic','image/heif','image/heic-sequence','image/heif-sequence'].includes(file?.type)||/\.(heic|heif)$/i.test(file?.name||'');}
export function validatePhotoFile(file){
 if(!file||(!['image/jpeg','image/png','image/webp'].includes(file.type)&&!isHeicFile(file)))throw new Error('写真はJPEG・PNG・WebP・HEIC／HEIFで選んでください。');
 if(!file.size||file.size>MAX_ORIGINAL_BYTES)throw new Error('写真は10MB以下で選んでください。');
}
let decoder;
export async function preparePhoto(file){
 validatePhotoFile(file);
 let bitmap;
 try{
  try{bitmap=await createImageBitmap(file);}catch{
   if(!isHeicFile(file))throw new Error('写真を読み込めませんでした。別の写真を選んでください。');
   // Unmodified, separately loaded LGPL library; conversion stays on the device.
   decoder??=import('https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/heic-to.js').catch(e=>{decoder=undefined;throw e;});
   const {heicTo}=await decoder;
   bitmap=await createImageBitmap(await heicTo({blob:file,type:'image/jpeg',quality:0.9}));
  }
  if(bitmap.width*bitmap.height>60000000)throw new Error('写真が大きすぎます。小さくして選び直してください。');
  const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
  if(!blob||blob.size>3*1024*1024)throw new Error('写真を3MB以下にできませんでした。小さい写真を選び直してください。');
  return blob;
 }catch(e){throw new Error(isHeicFile(file)?'HEICの変換に失敗しました。写真を選び直すか、JPEGで追加してください。':e.message||'写真を読み込めませんでした。');}
 finally{bitmap?.close();}
}
