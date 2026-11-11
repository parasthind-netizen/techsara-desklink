// Rollback with per-platform rollbackMode, against :3998.
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = []; const check = (n,c)=>{R.push(!!c);console.log((c?'PASS ':'FAIL ')+n);};
function once(s,ev,t=4000){return new Promise((res,rej)=>{const h=setTimeout(()=>rej(new Error('timeout '+ev)),t);s.once(ev,d=>{clearTimeout(h);res(d);});});}
(async()=>{
  const admin=io(URL,{transports:['websocket']});await once(admin,'connect');
  admin.emit('register',{type:'support',username:'tester',password:'test1234'});await once(admin,'login_success');

  // win rollback 1.3.9 -> 1.3.8, mac must stay 1.4.0
  const fp=once(admin,'admin_feed',5000);
  admin.emit('admin_activate_version','1.3.8');
  const ok=await once(admin,'admin_ok');
  check('rollback acked as rollback',/1\.3\.8/.test(ok)&&/rollback/i.test(ok));
  const feed=await fp;
  check('win feed now 1.3.8',feed.active==='1.3.8');
  check('mac feed untouched at 1.4.0',feed.activeMac==='1.4.0');
  check('rollbackMode aggregate on',feed.rollbackMode===true);
  check('rollbackWin true, rollbackMac false',feed.rollbackWin===true&&feed.rollbackMac===false);

  // a win canary push now must carry allowDowngrade:true; a mac push must NOT
  // (mac is not in rollback). Register one win + one mac outdated agent.
  const mk=async n=>{admin.emit('create_agent_slot',{name:n});const d=await once(admin,'agent_slot_created');return d.code.replace(/\D/g,'');};
  const inst=async(n,p,v)=>{const code=await mk(n);const s=io(URL,{transports:['websocket']});await once(s,'connect');const b=once(s,'client_bound');s.emit('register',{type:'client',clientId:n,appVersion:'1.4.0',platform:p,installCode:code});const secret=(await b).secret;s.disconnect();await new Promise(r=>setTimeout(r,120));const s2=io(URL,{transports:['websocket']});await once(s2,'connect');s2.emit('register',{type:'client',clientId:n,appVersion:v,platform:p,secret});await once(s2,'availability_state');return s2;};
  const w=await inst('RB Win','win32','1.2.0');   // outdated vs 1.3.8
  const winCheck=once(w,'check_update');
  admin.emit('admin_push_update_one','RB Win');
  await once(admin,'admin_ok');
  const wc=await winCheck;
  check('win canary push carries allowDowngrade=true (rollback)',wc.allowDowngrade===true);

  // roll forward to 1.3.9 clears rollback
  const fp2=once(admin,'admin_feed',5000);
  admin.emit('admin_activate_version','1.3.9');
  await once(admin,'admin_ok');
  const feed2=await fp2;
  check('roll-forward: win 1.3.9, rollback cleared, mac still 1.4.0',feed2.active==='1.3.9'&&feed2.rollbackMode===false&&feed2.activeMac==='1.4.0');

  admin.emit('remove_client','RB Win');
  await new Promise(r=>setTimeout(r,300));
  w.disconnect();admin.disconnect();
  const fails=R.filter(x=>!x).length;console.log(`\n${R.length-fails}/${R.length} passed`);process.exit(fails?1:0);
})().catch(e=>{console.error('err',e.message);process.exit(1);});
