// Export is requested explicitly; it does not trigger tile or data prefetching.
const button=document.createElement('button');
button.type='button';button.className='quiet';button.textContent='店舗データ（ODbL）';
document.querySelector('footer div').prepend(button);
button.addEventListener('click',()=>document.dispatchEvent(new Event('export-restaurants')));
