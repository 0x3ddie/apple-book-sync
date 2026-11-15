import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/account.js', import.meta.url), 'utf8');
const user = { id: 'pairing-test-owner', email: 'reader@example.test', name: 'Reader' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve=done; }); return { promise, resolve }; }
class Element extends EventTarget {
  hidden = false; disabled = false; value = ''; textContent = ''; children = []; attributes = new Map();
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=nodes; }
  setAttribute(name,value) { this.attributes.set(name,value); }
  focus() {}
  click() { if(!this.disabled)this.dispatchEvent(new Event('click')); }
}
async function setup({ claim, listDevices, confirm=()=>true, pending=[] }={}) {
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  get('devices-panel').hidden=true;
  const timers=new Map(),requests=[];let nextTimer=0,reloads=0,refreshes=0,closes=0,clears=0;
  // Stored keys are own enumerable properties, as with the real Storage object.
  const localStorage={};
  Object.defineProperties(localStorage,{getItem:{value:key=>Object.hasOwn(localStorage,key)?localStorage[key]:null},
    setItem:{value:(key,value)=>{localStorage[key]=String(value);}},removeItem:{value:key=>{delete localStorage[key];}}});
  for(const key of pending)localStorage[key]='{}';
  const confirms=[];
  const window=new EventTarget();
  window.OfflineBooks={async closeScope(){closes++;},async clearScope(){clears++;}};
  const document={getElementById:get,querySelector:get,createElement:()=>new Element(),body:new Element()};
  get('refresh').addEventListener('click',()=>{refreshes++;});
  const context={
    window,document,Headers,AbortSignal,Event,URL,Date,
    location:{hostname:'reader.example',href:'https://reader.example/',reload(){reloads++;}},
    localStorage,Object,confirm(message){confirms.push(message);return confirm(message);},
    setTimeout(callback,delay){const id=++nextTimer;timers.set(id,{callback,delay});return id;},
    clearTimeout(id){timers.delete(id);},
    fetch:async(path,options={})=>{
      const body=options.body?JSON.parse(options.body):undefined;
      requests.push({path,body,account:options.headers.get('X-Books-Account')});
      let result;
      if(path==='/api/session')result={mode:'cloud',user};
      else if(path==='/api/devices/pairing')result=await claim(body);
      else if(path==='/api/devices')result={devices:await(listDevices?.()??[])};
      else if(path==='/api/auth/sign-out')result={success:true};
      else throw Error(`Unexpected request: ${path}`);
      const status=result.httpStatus??200;
      return {ok:status>=200&&status<300,status,async json(){return result.body??result;}};
    },
  };
  vm.runInNewContext(source,context);
  await window.ReaderAccount.ready;
  return {
    window,get,requests,timers,document,localStorage,confirms,get clears(){return clears;},
    get reloads(){return reloads;},get refreshes(){return refreshes;},get closes(){return closes;},
    async open(){get('manage-devices').click();await flush();},
    async submit(code){get('pairing-code').value=code;get('pairing-code').dispatchEvent(new Event('input'));get('pairing-form').dispatchEvent(new Event('submit',{cancelable:true}));await flush();},
    async tick(){const entry=timers.entries().next().value;assert.ok(entry,'A pairing retry should be scheduled');timers.delete(entry[0]);entry[1].callback();await flush();},
  };
}
const pendingResult=()=>({deviceId:'new-mac',name:'QA Mac',expiresAt:new Date(Date.now()+300000).toISOString(),status:'awaiting_mac',confirmation:'048213'});

test('formatted six-digit code preserves leading zero and waits for matching Mac completion',async()=>{
  let linked=[];
  const qa=await setup({claim:async()=>pendingResult(),listDevices:()=>linked});
  await qa.open();
  await qa.submit('012 345');
  const sent=qa.requests.find(item=>item.path==='/api/devices/pairing');
  assert.deepEqual(sent.body,{code:'012345'});
  assert.equal(sent.account,user.id);
  assert.match(qa.get('pairing-status').textContent,/One last step/);
  assert.match(qa.get('pairing-status').textContent,/reader@example\.test/);
  assert.equal(qa.get('pairing-confirmation').textContent,'048 213');
  assert.equal(qa.get('pairing-confirmation').hidden,false);
  assert.equal(qa.refreshes,0);
  assert.equal(qa.get('pairing-code').disabled,true);
  linked=[{id:'another-mac',name:'Other Mac',lastSeenAt:null,revokedAt:null}];
  await qa.tick();
  assert.match(qa.get('pairing-status').textContent,/One last step/);
  assert.equal(qa.refreshes,0);
  linked=[{id:'new-mac',name:'QA Mac',lastSeenAt:null,revokedAt:null}];
  await qa.tick();
  assert.match(qa.get('pairing-status').textContent,/QA Mac is linked/);
  assert.equal(qa.get('pairing-confirmation').hidden,true);
  assert.equal(qa.get('pairing-confirmation').textContent,'');
  assert.equal(qa.refreshes,1);
  assert.equal(qa.get('pairing-code').disabled,false);
  assert.equal(qa.timers.size,0);
});

test('invalid pairing code response stays signed in and allows retry',async()=>{
  const qa=await setup({claim:async()=>({httpStatus:400,body:{error:'Pairing code is invalid or expired.'}})});
  let expired=0;qa.window.addEventListener('books-session-expired',()=>{expired++;});
  await qa.open();await qa.submit('123456');
  assert.match(qa.get('device-error').textContent,/invalid or expired/);
  assert.equal(qa.get('link-mac').disabled,false);
  assert.equal(qa.get('pairing-code').disabled,false);
  assert.equal(qa.window.ReaderAccount.current.user.id,user.id);
  assert.equal(qa.reloads,0);assert.equal(expired,0);assert.equal(qa.closes,0);
});

test('late claim response after account change cannot continue or render pairing success',async()=>{
  const claim=deferred();
  const qa=await setup({claim:()=>claim.promise});
  await qa.open();await qa.submit('123456');
  qa.window.dispatchEvent(new Event('books-account-changing'));
  const previous=qa.get('pairing-status').textContent;
  const calls=qa.requests.length;
  claim.resolve(pendingResult());await flush();
  assert.equal(qa.get('pairing-status').textContent,previous);
  assert.equal(qa.requests.length,calls);
  assert.equal(qa.timers.size,0);assert.equal(qa.refreshes,0);
});

test('late polling response after account change cannot announce completion or schedule more work',async()=>{
  const polling=deferred();let calls=0;
  const qa=await setup({claim:async()=>pendingResult(),listDevices:()=>++calls===1?[]:polling.promise});
  await qa.open();await qa.submit('123456');
  qa.window.dispatchEvent(new Event('books-account-changing'));
  const previous=qa.get('pairing-status').textContent;
  const previousRows=qa.get('device-list').children;
  polling.resolve([{id:'new-mac',name:'QA Mac',lastSeenAt:null,revokedAt:null}]);await flush();
  assert.equal(qa.get('pairing-status').textContent,previous);
  assert.equal(qa.get('device-list').children,previousRows,'A stale response must not render into a changed account');
  assert.equal(qa.timers.size,0);assert.equal(qa.refreshes,0);
});

test('closing device panel pauses pending checks and reopening resumes them',async()=>{
  const qa=await setup({claim:async()=>pendingResult()});
  await qa.open();await qa.submit('123456');
  assert.equal(qa.timers.size,1);
  qa.get('close-devices').click();assert.equal(qa.timers.size,0);
  const calls=qa.requests.length;
  await qa.open();
  assert.equal(qa.requests.length,calls+1);
  assert.equal(qa.timers.size,1);
});

test('a claim without a confirmation code is not shown as pending',async()=>{
  const qa=await setup({claim:async()=>{const result=pendingResult();delete result.confirmation;return result;}});
  await qa.open();await qa.submit('123456');
  assert.match(qa.get('device-error').textContent,/confirmation code/);
  assert.equal(qa.get('pairing-confirmation').hidden!==false,true);
  assert.equal(qa.get('pairing-code').disabled,false);
  assert.equal(qa.timers.size,0);
});

test('unsynced positions ask before sign-out instead of blocking it forever',async()=>{
  const prefix=`books-pending:account:${user.id}:`;
  let allow=false;
  const qa=await setup({confirm:()=>allow,pending:[`${prefix}BOOK1`,`${prefix}BOOK2`,'books-pending:account:someone-else:BOOK3']});
  qa.get('sign-out').click();await flush();
  assert.equal(qa.confirms.length,1);
  assert.match(qa.confirms[0],/2 reading positions haven’t synced/);
  assert.ok(!qa.requests.some(item=>item.path==='/api/auth/sign-out'));
  assert.equal(qa.get('sign-out').disabled,false);
  assert.equal(qa.reloads,0);
  allow=true;
  qa.get('sign-out').click();await flush();
  assert.ok(qa.requests.some(item=>item.path==='/api/auth/sign-out'));
  assert.equal(qa.localStorage.getItem(`${prefix}BOOK1`),null);
  assert.equal(qa.localStorage.getItem(`${prefix}BOOK2`),null);
  assert.equal(qa.localStorage.getItem('books-pending:account:someone-else:BOOK3'),'{}');
  assert.equal(qa.clears,1);assert.equal(qa.reloads,1);
});

test('sign-out without unsynced positions does not ask',async()=>{
  const qa=await setup();
  qa.get('sign-out').click();await flush();
  assert.equal(qa.confirms.length,0);
  assert.equal(qa.clears,1);assert.equal(qa.reloads,1);
});
