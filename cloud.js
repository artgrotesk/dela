/* Shared backend adapter: Supabase Auth + PostgREST. Authorization is enforced by database RLS. */
'use strict';
(() => {
 const config=window.DELA_CLOUD_CONFIG||{};
 const storageKey='dela-cloud-session:'+config.url;
 let session=null;
 try{session=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
 function configured(){
  try{
   const url=new URL(config.url);
   if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash)return false;
   if(config.key?.startsWith('sb_publishable_'))return true;
   if(!config.key?.startsWith('eyJ'))return false;
   const part=config.key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
   return JSON.parse(atob(part)).role==='anon';
  }catch{return false;}
 }
 function save(value){if(value&&!value.expires_at)value.expires_at=Math.floor(Date.now()/1000)+Number(value.expires_in||3600);session=value;if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}
 async function fetchJson(path,method='GET',body,token,extra={}){
  if(!configured())throw Error('Общая база ещё не подключена. Нужна настройка администратора.');
  const response=await fetch(config.url.replace(/\/$/,'')+path,{method,headers:{apikey:config.key,...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...extra},body:body!==undefined?JSON.stringify(body):undefined});
  let result;try{result=await response.json();}catch{result=null;}
  if(!response.ok){const error=Error(response.status===401?'Сессия истекла. Войдите снова.':response.status===403?'Нет доступа к общему реестру.':result?.code==='23505'?'Такая запись уже существует.':result?.message==='Registry already initialized'?'Реестр уже заполнен. Повторный импорт не заменяет общие данные.':path.startsWith('/auth/')?'Не удалось войти. Проверьте почту и пароль.':result?.code==='23514'?'Проверьте поля записи. В доходах учитываем только услуги за 2026 год.':'Не удалось выполнить запрос к общей базе.');error.status=response.status;throw error;}
  return result;
 }
 async function refresh(){
  if(!session?.refresh_token)throw Error('Войдите в общий реестр.');
  try{save(await fetchJson('/auth/v1/token?grant_type=refresh_token','POST',{refresh_token:session.refresh_token}));}
  catch(e){save(null);throw e;}
 }
 let refreshing=null;
 async function token(){
  if(!session)throw Error('Войдите в общий реестр.');
  if(!session.expires_at||session.expires_at*1000<Date.now()+60000){
   if(!refreshing)refreshing=refresh().finally(()=>{refreshing=null;});await refreshing;
  }
  return session.access_token;
 }
 async function rest(path,method='GET',body,extra={}){return fetchJson('/rest/v1/'+path,method,body,await token(),extra);}
 async function hasAccess(){return await rest('rpc/dela_has_access','POST',{})===true;}
 async function rows(table){const all=[];for(let start=0;;start+=1000){const batch=await rest('dela_'+table+'?select=*&order=created_at.asc,id.asc','GET',undefined,{Range:`${start}-${start+999}`});if(!Array.isArray(batch))throw Error('Некорректный ответ базы');all.push(...batch);if(batch.length<1000)return all;}}
 async function api(path,method='GET',body){
  if(method==='GET'&&['state','export'].includes(path)){
   if(!await hasAccess())throw Error('У этой учётной записи нет доступа к реестру. Обратитесь к администратору.');
   const tables=['cases','tasks','documents','transactions'];const data=await Promise.all(tables.map(rows));return Object.fromEntries(tables.map((key,i)=>[key,data[i]]));
  }
  const [table,id]=path.split('/');if(!['cases','tasks','documents','transactions'].includes(table))throw Error('Неизвестная операция');
  const result=await rest('dela_'+table+(id?'?id=eq.'+encodeURIComponent(id):''),method,body,{Prefer:'return=representation'});
  if(!result?.[0])throw Error('Запись не найдена или недоступна.');return {id:result[0].id};
 }
 async function signIn(email,password){
  save(await fetchJson('/auth/v1/token?grant_type=password','POST',{email,password}));
  if(!await hasAccess()){save(null);throw Error('У этой учётной записи нет доступа к реестру. Обратитесь к администратору.');}
 }
 async function signOut(){try{if(session)await fetchJson('/auth/v1/logout','POST',undefined,session.access_token);}finally{save(null);}}
 async function importData(data){if(!data||['cases','tasks','documents','transactions'].some(k=>!Array.isArray(data[k])))throw Error('Нужен JSON-экспорт реестра');return rest('rpc/dela_import_initial','POST',{payload:data});}
 window.DelaCloud=Object.freeze({api,configured,signIn,signOut,importData,isSignedIn:()=>Boolean(session)});
})();
