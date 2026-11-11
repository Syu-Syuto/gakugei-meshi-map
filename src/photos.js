export const MAX_ORIGINAL_BYTES=10*1024*1024;
export function validatePhotoFile(file){
 if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('写真はJPEG・PNG・WebPで選んでください。');
 if(!file.size||file.size>MAX_ORIGINAL_BYTES)throw new Error('写真は10MB以下で選んでください。');
}
export async function preparePhoto(file){
 validatePhotoFile(file);
 let bitmap;
 try{
  bitmap=await createImageBitmap(file);
  if(bitmap.width*bitmap.height>60000000)throw new Error('写真が大きすぎます。小さくして選び直してください。');
  const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
  if(!blob||blob.size>3*1024*1024)throw new Error('写真を3MB以下にできませんでした。小さい写真を選び直してください。');
  return blob;
 }catch(e){throw new Error(e.message||'写真を読み込めませんでした。別の写真を選んでください。');}
 finally{bitmap?.close();}
}
