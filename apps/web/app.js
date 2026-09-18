const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
let runResult=null,auditRunning=false,toastTimer;
const messages=['Discovering application surfaces…','Inspecting authentication…','Testing checkout like a real user…','Scanning exposed secrets…','Simulating a new customer…','Injecting 8s payment latency…','Checking API invariants…','Cross-checking evidence…'];

const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

function toast(msg){const t=$('#toast');if(!t)return;t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400)}
function openDrawer(){const d=$('#drawer');d?.classList.add('open');d?.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';setTimeout(()=>$('#repoInput')?.focus(),80)}
function closeDrawer(){const d=$('#drawer');d?.classList.remove('open');d?.setAttribute('aria-hidden','true');document.body.style.overflow=''}
function setProgress(index,state='active'){$$('#progress>div').forEach((row,i)=>{row.classList.remove('active','done');if(i<index)row.classList.add('done');if(i===index)row.classList.add(state);const s=$('small',row);if(s)s.textContent=i<index||state==='done'&&i===index?'Done':i===index?'Running':'Waiting'})}
function resultCard(run,error=''){const host=$('#drawerResult');if(!host)return;if(error){host.innerHTML=`<div class="result"><span>INCOMPLETE</span><b>Audit could not finish</b><p>${esc(error)}</p></div>`;return}if(!run){host.innerHTML='';return}host.innerHTML=`<div class="result"><span>${esc(run.before?.verdict||'FAILED')}</span><b>${esc(run.finding?.rootCause||'Finding confirmed')}</b><p>${esc(run.before?.reason||'')}</p><p><strong>${run.evidence?.length||0}</strong> evidence items · After fix: <strong>${esc(run.after?.verdict||'VERIFIED')}</strong></p></div>`}

async function runFlagshipAudit({drawer=true}={}){
  if(auditRunning)return runResult;auditRunning=true;if(drawer)openDrawer();resultCard(null);setProgress(0,'done');
  const status=$('#deepStatus');if(status)status.textContent='Starting sandbox and specialist verification engines…';
  let i=1;const timer=reducedMotion?null:setInterval(()=>{if(i<4)setProgress(i++)},650);
  try{
    const response=await fetch('/api/demo/flagship',{method:'POST',headers:{accept:'application/json'}});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
    runResult=payload.run;setProgress(3,'done');resultCard(runResult);applyRun(runResult);
    if(status)status.textContent=`Run ${runResult.runId}: ${runResult.before.verdict} → ${runResult.after.verdict}. ${runResult.evidence.length} evidence items collected.`;
    toast(`Deep Audit complete: ${runResult.before.verdict} → ${runResult.after.verdict}`);return runResult;
  }catch(e){const msg=String(e?.message??e);resultCard(null,msg);if(status)status.textContent=`Audit incomplete: ${msg}`;toast('Audit incomplete. Exact reason shown.');return null}
  finally{if(timer)clearInterval(timer);auditRunning=false}
}

function applyRun(run){
  const feed=$('#feed');if(feed)(run.events||[]).slice(-5).forEach(ev=>{const d=document.createElement('div');d.className='new';const time=new Date(ev.at).toLocaleTimeString([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});d.innerHTML=`<time>${esc(time)}</time><span>${esc(ev.message||ev.type)}</span>`;feed.append(d)});
  const count=$('#evidenceCount');if(count)count.textContent=`${run.evidence?.length||0} evidence items`;
  const processing=$('#processing');if(processing&&run.after?.verdict==='VERIFIED'){processing.innerHTML='<i style="font-style:normal;color:#28682b">✓</i> Graceful timeout recovery verified';processing.style.color='#28682b'}
  $$('#fixTimeline>div').forEach((step,index)=>{step.classList.remove('active');step.classList.add('done');if(index===7){const s=$('small',step);if(s)s.textContent=`${run.after?.verdict||'VERIFIED'} · ${run.regressions||0} regressions`}});
}

function typeStatus(){
  const el=$('#typedStatus');if(!el)return;if(reducedMotion){el.textContent=messages[0];return}
  let m=0,c=0,del=false;const tick=()=>{const text=messages[m];c+=del?-1:1;el.textContent=text.slice(0,Math.max(0,c));
    if(!del&&c>=text.length){del=true;return setTimeout(tick,1200)}if(del&&c<=0){del=false;m=(m+1)%messages.length}
    setTimeout(tick,del?20:36)};tick()
}
function rotateLine(){if(reducedMotion)return;const el=$('#rotatingLine');if(!el)return;const lines=['before your users do.','before production does.','before the incident does.','before the demo does.'];let i=0;setInterval(()=>{el.classList.add('changing');setTimeout(()=>{i=(i+1)%lines.length;el.textContent=lines[i];el.classList.remove('changing')},200)},2900)}

function reveal(){
  const els=$$('.reveal');if(reducedMotion||!('IntersectionObserver'in window)){els.forEach(e=>e.classList.add('visible'));return}
  const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target)}}),{threshold:.1,rootMargin:'0px 0px -7% 0px'});els.forEach((e,i)=>{e.style.transitionDelay=`${(i%4)*45}ms`;io.observe(e)})
}
function animateCounter(el){const end=Number(el.dataset.counter||0),suffix=el.dataset.suffix||'';if(reducedMotion){el.textContent=`${end}${suffix}`;return}const start=performance.now(),dur=900;const frame=now=>{const p=Math.min(1,(now-start)/dur),ease=1-Math.pow(1-p,3);el.textContent=`${Math.round(end*ease)}${suffix}`;if(p<1)requestAnimationFrame(frame)};requestAnimationFrame(frame)}
function counters(){const els=$$('[data-counter]');if(!('IntersectionObserver'in window)){els.forEach(animateCounter);return}const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){animateCounter(e.target);io.unobserve(e.target)}}),{threshold:.5});els.forEach(e=>io.observe(e))}
function scrollMotion(){let tick=false;const nav=$('#nav');const update=()=>{nav?.classList.toggle('scrolled',scrollY>12);tick=false};addEventListener('scroll',()=>{if(tick)return;tick=true;requestAnimationFrame(update)},{passive:true});update()}
function cycleEngines(){if(reducedMotion)return;const nodes=$$('[data-engine]');let i=0;setInterval(()=>{nodes.forEach((n,j)=>n.classList.toggle('active',j===i));i=(i+1)%nodes.length},800)}
function cards(){$$('.engine-card').forEach(card=>$('.expand',card)?.addEventListener('click',()=>card.classList.toggle('expanded')))}
function reportTabs(){$$('.report-tab').forEach(tab=>tab.addEventListener('click',()=>{$$('.report-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');$('#reportBody')?.animate?.([{opacity:.35,transform:'translateY(7px)'},{opacity:1,transform:'translateY(0)'}],{duration:reducedMotion?1:220,easing:'cubic-bezier(.2,.8,.2,1)'})}))}
function steer(){$('#steerForm')?.addEventListener('submit',e=>{e.preventDefault();const input=$('#steerInput'),resp=$('#chatResponse'),host=$('#branchCards');if(!input||!resp||!host)return;resp.textContent="Running additional payment-state experiments now.";const node=document.createElement('div');node.innerHTML=`<b>${esc(input.value||'Additional check')}</b><small>Running</small>`;host.append(node);toast('New investigation branch started')})}
function actions(){$$('[data-audit-trigger]').forEach(b=>b.addEventListener('click',openDrawer));$('#closeDrawer')?.addEventListener('click',closeDrawer);$('#backdrop')?.addEventListener('click',closeDrawer);$('#drawerRun')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#watchAudit')?.addEventListener('click',()=>{$('#live-audit')?.scrollIntoView({behavior:reducedMotion?'auto':'smooth'});setTimeout(()=>runFlagshipAudit({drawer:false}),reducedMotion?0:420)});$('#runAuditFromConsole')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#runDeepAudit')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#createPr')?.addEventListener('click',()=>toast('Repair ready for human review before any merge.'));$('#payDemo')?.addEventListener('click',()=>toast('Payment-timeout experiment replayed.'));addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()})}
function mobile(){$('#menu')?.addEventListener('click',()=>{const b=$('#menu'),n=$('#navlinks');const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));n?.classList.toggle('mobile-open',!open)})}
function agentCycle(){if(reducedMotion)return;const rows=$$('#agentList li');let idx=0;setInterval(()=>{rows.forEach((r,i)=>{const dot=$('i',r),s=$('small',r);if(i===idx){dot.className='';s.textContent='Running'}else if(i<idx){dot.className='ok';s.textContent='Verified'}});idx=(idx+1)%rows.length},1350)}

reveal();counters();scrollMotion();cycleEngines();cards();reportTabs();steer();actions();mobile();agentCycle();typeStatus();rotateLine();
