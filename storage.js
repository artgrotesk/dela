/* GitHub Pages adapter. Private records stay in this browser, never in the site bundle. */
'use strict';
(() => {
 const keys=['cases','tasks','documents','transactions'];
 const empty=()=>({cases:[],tasks:[],documents:[],transactions:[]});
 const clone=v=>structuredClone(v);
 const request=indexedDB.open('dela-personal-v1',1);
 const dbPromise=new Promise((resolve,reject)=>{
  request.onupgradeneeded=()=>request.result.createObjectStore('records');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(Error('Браузер не разрешил локальное хранение. Разрешите данные сайта.'));
  request.onblocked=()=>reject(Error('Закройте другие вкладки реестра и повторите.'));
 });
 const enumCheck=(value,options)=>{if(!options.includes(value))throw Error('Неизвестный статус или тип записи');};
 const text=(value,required=false)=>{if(typeof value!=='string'||value.length>20000||(required&&!value.trim()))throw Error('Проверьте текстовые поля');};
 const integer=(value,nullable=false)=>{if(nullable&&value===null)return;if(!Number.isSafeInteger(value)||value<0||value>1e12)throw Error('Проверьте сумму или время');};
 const date=(value,nullable=false)=>{if(nullable&&value===null)return;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw Error('Некорректная дата');};
 function validate(data){
  if(!data||typeof data!=='object'||keys.some(k=>!Array.isArray(data[k])||data[k].length>50000))throw Error('Нужен JSON-экспорт реестра с делами, задачами, документами и операциями');
  for(const table of keys){const ids=new Set();for(const row of data[table]){if(!row||typeof row!=='object')throw Error('Некорректная запись');text(row.id,true);if(ids.has(row.id))throw Error('Повторяющийся идентификатор');ids.add(row.id);}}
  const caseIds=new Set(data.cases.map(c=>c.id));
  for(const c of data.cases){for(const k of ['client','title'])text(c[k],true);for(const k of ['number','court','description','source'])text(c[k]);enumCheck(c.status,['active','paused','closed']);enumCheck(c.color,['sage','amber','blue','rose','purple']);integer(c.fee,true);}
  for(const table of ['tasks','documents','transactions'])for(const row of data[table])if(!caseIds.has(row.case_id))throw Error('Запись ссылается на отсутствующее дело');
  for(const t of data.tasks){text(t.title,true);text(t.assignee);enumCheck(t.status,['todo','doing','done']);enumCheck(t.priority,['normal','high']);date(t.due,true);integer(t.minutes);}
  const documents=new Set();
  for(const d of data.documents){enumCheck(d.kind,['Договор','Спецификация','Акт','Счёт']);enumCheck(d.status,['unknown','needed','ready','sent','signed']);text(d.note);const key=d.case_id+'|'+d.kind;if(documents.has(key))throw Error('Повторяющийся документ');documents.add(key);}
  for(const t of data.transactions){enumCheck(t.kind,['income','expense']);integer(t.amount);if(!t.amount)throw Error('Сумма должна быть больше нуля');date(t.date);text(t.note);if(t.kind==='income'&&t.service_year!==2026)throw Error('Учитываются только оплаты услуг за 2026 год');}
  return Object.fromEntries(keys.map(k=>[k,clone(data[k])]));
 }
 async function transaction(edit){
  const db=await dbPromise;
  return new Promise((resolve,reject)=>{
   const tx=db.transaction('records',edit?'readwrite':'readonly');const store=tx.objectStore('records');const read=store.get('state');let result;
   read.onsuccess=()=>{try{const state=read.result||empty();result=edit?edit(state):clone(state);if(edit)store.put(state,'state');}catch(e){reject(e);tx.abort();}};
   tx.oncomplete=()=>resolve(result);
   tx.onerror=()=>reject(Error('Не удалось сохранить данные. Проверьте свободное место и разрешения браузера.'));
   tx.onabort=()=>reject(Error('Сохранение отменено. Исходные данные не изменены.'));
  });
 }
 async function api(path,method='GET',body){
  if(method==='GET'&&['state','export'].includes(path))return transaction();
  const [table,id]=path.split('/');
  if(!keys.includes(table)||!['POST','PATCH'].includes(method))throw Error('Операция не поддерживается');
  return transaction(state=>{
   let row;
   if(method==='POST'){
    if(id||table==='documents')throw Error('Операция не поддерживается');
    const defaults={cases:{number:'',court:'',description:'',status:'active',fee:null,color:'sage',source:'Внесено вручную'},tasks:{status:'todo',priority:'normal',due:null,assignee:'',minutes:0},transactions:{service_year:null,note:''}};
    row={...defaults[table],...body,id:crypto.randomUUID()};state[table].push(row);
    if(table==='cases')for(const kind of ['Договор','Спецификация','Акт','Счёт'])state.documents.push({id:crypto.randomUUID(),case_id:row.id,kind,status:'unknown',note:''});
   }else{
    row=state[table].find(r=>r.id===id);if(!row)throw Error('Запись не найдена');Object.assign(row,body,{id});
   }
   validate(state);
   return {id:row.id};
  });
 }
 async function importData(value){const checked=validate(value);return transaction(state=>{for(const k of keys)state[k]=checked[k];return true;});}
 window.DelaLocal=Object.freeze({api,importData});
})();
