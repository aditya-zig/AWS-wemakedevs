const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
let runResult=null,auditRunning=false,toastTimer;
const messages=['Discovering application surfaces…','Inspecting authentication…','Testing checkout like a real user…','Scanning exposed secrets…','Simulating a new customer…','Injecting 8s payment latency…','Checking API invariants…','Cross-checking evidence…'];

const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

function toast(msg){const t=$('#toast');if(!t)return;t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400)}
function openDrawer(){const d=$('#drawer');d?.classList.add('open');d?.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';setTimeout(()=>$('#repoInput')?.focus(),80)}
function closeDrawer(){const d=$('#drawer');d?.classList.remove('open');d?.setAttribute('aria-hidden','true');document.body.style.overflow=''}
function setProgress(index,state='active'){$$('#progress>div').forEach((row,i)=>{row.classList.remove('active','done');if(i<index)row.classList.add('done');if(i===index)row.classList.add(state);const s=$('small',row);if(s)s.textContent=i<index||state==='done'&&i===index?'Done':i===index?'Running':'Waiting'})}
function resultCard(run,error=''){const host=$('#drawerResult');if(!host)return;if(error){host.innerHTML=`<div class="result"><span>INCOMPLETE</span><b>Audit could not finish</b><p>${esc(error)}</p></div>`;return}if(!run){host.innerHTML='';return}const confirmed=(run.findings||[]).filter(f=>f.state==='Confirmed').length,inc=run.coverage?.incomplete||0;host.innerHTML=`<div class="result"><span>${esc(run.overall||'Deep Audit')}</span><b>${confirmed} confirmed findings · ${run.coverage?.percentage||0}% coverage</b><p>${esc(run.findings?.[0]?.summary||'Audit completed with executed evidence.')}</p><p><strong>${run.engines?.length||0}</strong> engines · <strong>${inc}</strong> incomplete · estimated spend <strong>$${Number(run.guardrails?.estimatedRunSpendUsd||0).toFixed(2)}</strong> / $${Number(run.guardrails?.hardRunCapUsd||0).toFixed(2)}</p></div>`}

function auditPayload(){
  let raw=$('#repoInput')?.value?.trim()||'aditya-zig/AWS-wemakedevs';
  raw=raw.replace(/^https?:\/\/github\.com\//,'').replace(/^github\.com\//,'').replace(/\.git$/,'');
  const [fullName,branch='main']=raw.split('#');
  if(!/^[^/]+\/[^/]+$/.test(fullName))throw new Error('Use owner/repo or github.com/owner/repo. Add #branch if needed.');
  const deployedUrl=$('#deployedUrlInput')?.value?.trim()||undefined;
  return{
    repository:{provider:'github',fullName,url:`https://github.com/${fullName}`,branch},
    target:deployedUrl?{id:`target-${Date.now()}`,url:deployedUrl,environment:'shared-observation',immutable:true}:null,
    objective:'Run a real Deep Audit with executed evidence. Separate confirmed issues, uncertainty, user-behavior insights and improvement opportunities.'
  }
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function swarmResultCard(audit,error=''){
  const host=$('#drawerResult');if(!host)return;
  if(error){host.innerHTML=`<div class="result"><span>INCOMPLETE</span><b>Real swarm could not finish</b><p>${esc(error)}</p></div>`;return}
  const state=audit?.state, reports=state?.reports||[];
  const confirmed=reports.filter(r=>r.findingState==='Confirmed').reduce((n,r)=>n+(r.findings?.length||0),0);
  host.innerHTML=`<div class="result"><span>${esc(audit?.mode||'real swarm').toUpperCase()}</span><b>${confirmed} confirmed issues · ${state?.plan?.tasks?.length||0} workers planned</b><p>${esc(audit?.result?.outcome||state?.finished?'Audit finished':'Audit running')}</p><p><strong>${state?.activeWorkerIds?.length||0}</strong> active · <strong>${state?.evidence?.length||0}</strong> evidence · estimated spend <strong>${Number(state?.guardrails?.estimatedSpendUsd||0).toFixed(2)}</strong> / ${Number(state?.guardrails?.hardRunSpendUsd||0).toFixed(2)}</p></div>`;
}
async function fetchSwarm(auditId){
  const response=await fetch(`/api/audits/${encodeURIComponent(auditId)}/swarm`,{headers:{accept:'application/json'}});
  const payload=await response.json();if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
  return payload.audit;
}
async function runFlagshipAudit({drawer=true}={}){
  if(auditRunning)return runResult;auditRunning=true;if(drawer)openDrawer();swarmResultCard(null);setProgress(0,'done');
  const status=$('#deepStatus');if(status)status.textContent='Resolving the exact commit and launching the real Strands swarm…';
  let i=1;const timer=reducedMotion?null:setInterval(()=>{if(i<3)setProgress(i++)},900);
  try{
    const request=auditPayload();
    const response=await fetch('/api/audits',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify(request)});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
    runResult=payload.audit;applySwarm(runResult);swarmResultCard(runResult);
    while(!runResult.state?.finished&&!runResult.error){
      await delay(500);runResult=await fetchSwarm(runResult.auditId);applySwarm(runResult);swarmResultCard(runResult);
    }
    if(runResult.error)throw new Error(runResult.error);
    setProgress(3,'done');applySwarm(runResult);swarmResultCard(runResult);
    const confirmed=(runResult.state?.reports||[]).filter(r=>r.findingState==='Confirmed').reduce((n,r)=>n+(r.findings?.length||0),0);
    if(status)status.textContent=`${runResult.result?.outcome||'completed'} · ${runResult.state?.plan?.tasks?.length||0} workers · ${runResult.state?.evidence?.length||0} evidence items`;
    toast(`Real Deep Audit complete: ${confirmed} confirmed issues`);return runResult;
  }catch(e){const msg=String(e?.message??e);swarmResultCard(null,msg);if(status)status.textContent=`Audit incomplete: ${msg}`;toast('Audit incomplete. Exact reason shown.');return null}
  finally{if(timer)clearInterval(timer);auditRunning=false}
}

function applyRun(run){
  const feed=$('#feed');if(feed){feed.innerHTML='';(run.events||[]).slice(-10).forEach(ev=>{const d=document.createElement('div');d.className=/incomplete|fail/i.test(ev.type)?'alert new':'new';const time=new Date(ev.at).toLocaleTimeString([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});d.innerHTML=`<time>${esc(time)}</time><span>${esc(ev.engine?`${ev.engine}: ${ev.message}`:ev.message||ev.type)}</span>`;feed.append(d)})}
  const totalEvidence=(run.engines||[]).reduce((n,e)=>n+(e.evidence?.length||0),0),count=$('#evidenceCount');if(count)count.textContent=`${totalEvidence} evidence items · ${run.coverage?.percentage||0}% coverage`;
  const list=$('#agentList');if(list){const started=new Set((run.events||[]).filter(e=>e.type==='engine.started').map(e=>e.engine));const completed=new Set((run.engines||[]).map(e=>e.name));const names=[...new Set([...started,...completed])];list.innerHTML=names.map(name=>{const e=(run.engines||[]).find(x=>x.name===name);if(!e)return`<li><i></i><span>${esc(name)}</span><small>Running</small></li>`;const cls=e.state==='completed'&&e.status==='pass'?'ok':e.state==='unknown'?'idle':'';const label=e.state==='incomplete'?'Incomplete':e.status==='fail'?'Finding':e.status==='pass'?'Verified':'Unknown';return`<li><i class="${cls}"></i><span>${esc(e.name)}</span><small title="${esc(e.reason||'')}">${esc(label)}</small></li>`}).join('')}
  const report=$('#reportBody'),findings=[...(run.findings||[])];if(report&&findings.length){const weight={Critical:0,High:1,Medium:2,Low:3,Unknown:4};findings.sort((a,b)=>(weight[a.impact]??5)-(weight[b.impact]??5));report.innerHTML=`<div class="meta"><span>${findings.filter(f=>f.impact==='Critical').length} CRITICAL</span><em>${findings.filter(f=>f.state==='Confirmed').length} Confirmed</em><small>${run.coverage?.tested||0}/${run.coverage?.total||0} tested · ${run.coverage?.incomplete||0} incomplete · ${run.coverage?.unknown||0} unknown</small></div><div class="finding-list">${findings.map(f=>`<section class="finding-row"><div><span class="impact">${esc(f.impact||'Unknown')}</span><em>${esc(f.state||'Unknown')}</em><small>${esc(f.category||'Finding')}</small></div><h3>${esc(f.summary)}</h3><p><b>Root cause / reason:</b> ${esc(f.rootCause||'Not established')}</p><div class="chips">${(f.evidence||[]).slice(0,5).map(e=>`<span>${esc(e.kind||e.source||'evidence')}</span>`).join('')}</div></section>`).join('')}</div><button class="btn darkbtn" onclick="document.querySelector('#fix-verification')?.scrollIntoView({behavior:'smooth'})">Review verified fix</button>`}
  const processing=$('#processing');if(processing&&run.fix?.status==='verified'){processing.innerHTML='<i style="font-style:normal;color:#28682b">✓</i> Graceful timeout recovery verified';processing.style.color='#28682b'}
  if(run.fix?.status==='verified')$$('#fixTimeline>div').forEach((step,index)=>{step.classList.remove('active');step.classList.add('done');if(index===7){const x=$('small',step);if(x)x.textContent=`VERIFIED · ${run.fix.regressionFailures} regressions`}});
  const stats=$$('.proofstats div b');if(stats.length>=3&&run.fix){stats[0].textContent=`${run.fix.before.reproduced}/${run.fix.before.attempts}`;stats[1].textContent=`${run.fix.targeted.passed}/${run.fix.targeted.total}`;stats[2].textContent=String(run.fix.regressionFailures)}
  const proof=$('.proof');if(proof&&run.fix){let diff=$('#fixDiff');if(!diff){diff=document.createElement('div');diff.id='fixDiff';diff.className='fix-diff';proof.prepend(diff)}diff.innerHTML=`<small>Sandbox patch</small><pre>${esc(run.fix.patch||'No patch available')}</pre><div class="regression-list">${(run.fix.regressions||[]).map(r=>`<span>${esc(r.name)} <b>${esc(r.status)}</b></span>`).join('')}</div>`;const player=$('.player span',proof);if(player&&run.fix.proofVideo)player.textContent=`Proof-of-fix · ${String(run.fix.proofVideo.durationSeconds||0).padStart(2,'0')}s · redacted`}
  const create=$('#createPr');if(create){create.disabled=!run.fix?.pr?.ready;create.textContent=run.fix?.pr?.ready?'Create pull request':'PR blocked until verified'}
}

function applySwarm(audit){
  const state=audit?.state||{},plan=state.plan||{tasks:[]},events=state.events||[],reports=state.reports||[];
  const feed=$('#feed');if(feed){feed.innerHTML='';events.slice(-14).forEach(ev=>{const d=document.createElement('div');d.className=/incomplete|fail|error/i.test(ev.type||'')?'alert new':'new';const time=ev.at?new Date(ev.at).toLocaleTimeString([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';d.innerHTML=`<time>${esc(time)}</time><span>${esc(ev.message||ev.type||'worker activity')}</span>`;feed.append(d)})}
  const count=$('#evidenceCount');if(count)count.textContent=`${state.evidence?.length||0} executed evidence items · ${state.activeWorkerIds?.length||0} workers active`;
  const list=$('#agentList');if(list){list.innerHTML=(plan.tasks||[]).map(task=>{const report=reports.find(r=>r.role===task.role&&r.workerId&&events.some(ev=>ev.workerId===r.workerId));const workerEvents=events.filter(ev=>report&&ev.workerId===report.workerId);const evidenceEvents=workerEvents.filter(ev=>ev.type==='worker.evidence');const captures=evidenceEvents.filter(ev=>ev.evidence?.source==='computer-use');const status=task.state==='completed'?'Verified':task.state==='skipped'?'Skipped':task.state==='incomplete'?'Incomplete':task.state==='failed'?'Failed':task.state==='running'?'Running':'Queued';const cls=task.state==='completed'?'ok':task.state==='skipped'?'idle':'';return`<li class="swarm-card"><i class="${cls}"></i><span><b>${esc(task.role)}</b><small>${esc(task.objective)}</small><details><summary>Evidence & activity</summary><small>${esc(task.skipReason||task.lastError||'')}${task.skipReason||task.lastError?'<br>':''}${evidenceEvents.length} evidence · ${workerEvents.length} events · ${captures.length} browser captures</small></details></span><small>${esc(status)}</small></li>`}).join('')}
  const confirmed=[],uncertain=[],behavior=[],improvements=[];
  reports.forEach(r=>{const items=(r.findings?.length?r.findings:[r.summary]).filter(Boolean);if(r.role==='browser-app-user')behavior.push(...items.map(text=>({text,r})));else if(r.role==='performance-discovery'&&r.findingState!=='Confirmed')improvements.push(...items.map(text=>({text,r})));else if(r.findingState==='Confirmed')confirmed.push(...items.map(text=>({text,r})));else uncertain.push(...items.map(text=>({text,r})))});
  const bucket=(title,items)=>`<section class="finding-row"><div><span class="impact">${esc(title)}</span><em>${items.length}</em></div>${items.length?items.map(({text,r})=>`<h3>${esc(text)}</h3><p><b>${esc(r.role)}</b> · ${esc(r.findingState)} · ${r.evidence?.length||0} evidence</p>`).join(''):'<p class="muted">None yet.</p>'}</section>`;
  const report=$('#reportBody');if(report)report.innerHTML=`<div class="meta"><span>REAL SWARM</span><em>${confirmed.length} Confirmed</em><small>${plan.tasks?.length||0} workers · ${state.evidence?.length||0} evidence</small></div><div class="finding-list">${bucket('Confirmed issues',confirmed)}${bucket('Unconfirmed / Unknown / Incomplete',uncertain)}${bucket('User-behavior insights',behavior)}${bucket('Improvement opportunities',improvements)}</div>`;
  const status=$('#deepStatus');if(status&&!state.finished)status.textContent=`${audit.mode} swarm · ${state.activeWorkerIds?.length||0} active · ${plan.tasks?.filter(t=>t.state==='queued').length||0} queued · ${Number(state.guardrails?.estimatedSpendUsd||0).toFixed(2)} estimated`;
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
function steer(){$('#steerForm')?.addEventListener('submit',async e=>{e.preventDefault();const input=$('#steerInput'),resp=$('#chatResponse'),host=$('#branchCards');if(!input||!resp||!host)return;if(!runResult?.auditId){resp.textContent='Run the real Deep Audit first so steering has live evidence to work from.';return}resp.textContent='Queueing a bounded investigator inside the live swarm…';try{const r=await fetch(`/api/audits/${encodeURIComponent(runResult.auditId)}/steer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({objective:input.value})});const p=await r.json();if(!r.ok)throw new Error(p.error||`HTTP ${r.status}`);runResult=p.audit;applySwarm(runResult);resp.textContent='Investigator queued. It will use the current audit evidence and scoped tools.';const node=document.createElement('div');node.innerHTML=`<b>${esc(input.value||'Additional check')}</b><small>Queued investigator</small>`;host.append(node);toast('Investigator added to live swarm')}catch(err){resp.textContent=`Steering incomplete: ${String(err?.message??err)}`}})}
function actions(){$$('[data-audit-trigger]').forEach(b=>b.addEventListener('click',openDrawer));$('#closeDrawer')?.addEventListener('click',closeDrawer);$('#backdrop')?.addEventListener('click',closeDrawer);$('#drawerRun')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#watchAudit')?.addEventListener('click',()=>{$('#live-audit')?.scrollIntoView({behavior:reducedMotion?'auto':'smooth'});setTimeout(()=>runFlagshipAudit({drawer:false}),reducedMotion?0:420)});$('#runAuditFromConsole')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#runDeepAudit')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#createPr')?.addEventListener('click',async()=>{if(!runResult)return toast('Run Deep Audit first.');try{const r=await fetch(`/api/demo/deep-audit/${encodeURIComponent(runResult.runId)}/pr`,{method:'POST'});const p=await r.json();if(!r.ok)throw new Error(p.error||`HTTP ${r.status}`);toast(`PR package verified: ${p.pr.branch}. Human merge control retained.`)}catch(err){toast(`PR gate closed: ${String(err?.message??err)}`)}});$('#payDemo')?.addEventListener('click',()=>toast('Payment-timeout experiment replayed.'));addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()})}
function mobile(){$('#menu')?.addEventListener('click',()=>{const b=$('#menu'),n=$('#navlinks');const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));n?.classList.toggle('mobile-open',!open)})}
function agentCycle(){if(reducedMotion)return;let idx=0;setInterval(()=>{if(runResult?.runId)return;const rows=$$('#agentList li');if(!rows.length)return;rows.forEach((r,i)=>{const dot=$('i',r),s=$('small',r);if(i===idx){dot.className='';s.textContent='Running'}else if(i<idx){dot.className='ok';s.textContent='Verified'}});idx=(idx+1)%rows.length},1350)}

reveal();counters();scrollMotion();cycleEngines();cards();reportTabs();steer();actions();mobile();agentCycle();typeStatus();rotateLine();

if($('#repoInput')?.value==='github.com/acme/checkout')$('#repoInput').value='github.com/aditya-zig/AWS-wemakedevs';
