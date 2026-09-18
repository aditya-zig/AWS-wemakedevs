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

function auditPayload(){const repository=$('#repoInput')?.value?.trim()||'github.com/acme/checkout',deployedUrl=$('#deployedUrlInput')?.value?.trim()||undefined,installableApp=$('#installableAppInput')?.value?.trim()||undefined,tempToken=$('#tempTokenInput')?.value||'';return{repository,deployedUrl,installableApp,credentials:tempToken?{TEMP_TOKEN:tempToken}:{},guardrails:{creditCeilingUsd:100,reserveUsd:15,maxRunUsd:2.5,maxHttpRequests:80,maxConcurrentEngines:4}}}

async function runFlagshipAudit({drawer=true}={}){
  if(auditRunning)return runResult;auditRunning=true;if(drawer)openDrawer();resultCard(null);setProgress(0,'done');
  const status=$('#deepStatus');if(status)status.textContent='Discovering repo and launching the default Deep Audit…';
  let i=1;const timer=reducedMotion?null:setInterval(()=>{if(i<4)setProgress(i++)},650);
  try{
    const response=await fetch('/api/demo/deep-audit',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify(auditPayload())});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
    runResult=payload.run;setProgress(3,'done');resultCard(runResult);applyRun(runResult);
    if(status)status.textContent=`${runResult.overall} · ${runResult.coverage.percentage}% coverage · $${Number(runResult.guardrails.estimatedRunSpendUsd).toFixed(2)} estimated`;
    toast(`Deep Audit complete: ${runResult.findings.filter(f=>f.state==='Confirmed').length} confirmed findings`);return runResult;
  }catch(e){const msg=String(e?.message??e);resultCard(null,msg);if(status)status.textContent=`Audit incomplete: ${msg}`;toast('Audit incomplete. Exact reason shown.');return null}
  finally{if(timer)clearInterval(timer);auditRunning=false}
}

function applyRun(run){
  const feed=$('#feed');if(feed){feed.innerHTML='';(run.events||[]).slice(-8).forEach(ev=>{const d=document.createElement('div');d.className=/incomplete|fail/i.test(ev.type)?'alert new':'new';const time=new Date(ev.at).toLocaleTimeString([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});d.innerHTML=`<time>${esc(time)}</time><span>${esc(ev.engine?`${ev.engine}: ${ev.message}`:ev.message||ev.type)}</span>`;feed.append(d)})}
  const totalEvidence=(run.engines||[]).reduce((n,e)=>n+(e.evidence?.length||0),0),count=$('#evidenceCount');if(count)count.textContent=`${totalEvidence} evidence items · ${run.coverage?.percentage||0}% coverage`;
  const list=$('#agentList');if(list)list.innerHTML=(run.engines||[]).map(e=>{const cls=e.state==='completed'&&e.status==='pass'?'ok':e.state==='unknown'?'idle':'';const label=e.state==='incomplete'?'Incomplete':e.status==='fail'?'Finding':e.status==='pass'?'Verified':'Unknown';return`<li><i class="${cls}"></i><span>${esc(e.name)}</span><small title="${esc(e.reason||'')}">${esc(label)}</small></li>`}).join('');
  const report=$('#reportBody'),finding=(run.findings||[]).find(f=>f.state==='Confirmed')||run.findings?.[0];if(report&&finding)report.innerHTML=`<div class="meta"><span>${esc(finding.impact||'UNKNOWN')}</span><em>${esc(finding.state)}</em><small>${run.coverage?.percentage||0}% coverage · ${run.coverage?.incomplete||0} incomplete</small></div><h3>${esc(finding.summary)}</h3><div class="reportcols"><div><b>Root cause</b><p>${esc(finding.rootCause||'Still being cross-checked.')}</p></div><div><b>Coverage</b><p>${run.coverage.tested}/${run.coverage.total} checks completed. Unknown and incomplete checks are never counted as passes.</p></div></div><div class="chips">${(finding.evidence||[]).slice(0,6).map(e=>`<span>${esc(e.kind||e.source||'evidence')}</span>`).join('')}</div><button class="btn darkbtn" onclick="document.querySelector('#fix-verification')?.scrollIntoView({behavior:'smooth'})">Review verified fix</button>`;
  const processing=$('#processing');if(processing&&run.fix?.status==='verified'){processing.innerHTML='<i style="font-style:normal;color:#28682b">✓</i> Graceful timeout recovery verified';processing.style.color='#28682b'}
  if(run.fix?.status==='verified')$$('#fixTimeline>div').forEach((step,index)=>{step.classList.remove('active');step.classList.add('done');if(index===7){const x=$('small',step);if(x)x.textContent=`VERIFIED · ${run.fix.regressionFailures} regressions`}});
  const stats=$$('.proofstats div b');if(stats.length>=3&&run.fix){stats[0].textContent=`${run.fix.before.reproduced}/${run.fix.before.attempts}`;stats[1].textContent=`${run.fix.targeted.passed}/${run.fix.targeted.total}`;stats[2].textContent=String(run.fix.regressionFailures)}
  const create=$('#createPr');if(create){create.disabled=!run.fix?.pr?.ready;create.textContent=run.fix?.pr?.ready?'Create pull request':'PR blocked until verified'}
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
function steer(){$('#steerForm')?.addEventListener('submit',async e=>{e.preventDefault();const input=$('#steerInput'),resp=$('#chatResponse'),host=$('#branchCards');if(!input||!resp||!host)return;if(!runResult){resp.textContent='Run Deep Audit first so steering has live evidence to work from.';return}resp.textContent='Running a bounded follow-up against the current audit evidence…';try{const r=await fetch(`/api/demo/deep-audit/${encodeURIComponent(runResult.runId)}/steer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instruction:input.value})});const p=await r.json();if(!r.ok)throw new Error(p.error||`HTTP ${r.status}`);resp.textContent=p.event.message;const node=document.createElement('div');node.innerHTML=`<b>${esc(input.value||'Additional check')}</b><small>Evidence linked</small>`;host.append(node);toast('Steered investigation completed')}catch(err){resp.textContent=`Steering incomplete: ${String(err?.message??err)}`}})}
function actions(){$$('[data-audit-trigger]').forEach(b=>b.addEventListener('click',openDrawer));$('#closeDrawer')?.addEventListener('click',closeDrawer);$('#backdrop')?.addEventListener('click',closeDrawer);$('#drawerRun')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#watchAudit')?.addEventListener('click',()=>{$('#live-audit')?.scrollIntoView({behavior:reducedMotion?'auto':'smooth'});setTimeout(()=>runFlagshipAudit({drawer:false}),reducedMotion?0:420)});$('#runAuditFromConsole')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#runDeepAudit')?.addEventListener('click',()=>runFlagshipAudit({drawer:false}));$('#createPr')?.addEventListener('click',async()=>{if(!runResult)return toast('Run Deep Audit first.');try{const r=await fetch(`/api/demo/deep-audit/${encodeURIComponent(runResult.runId)}/pr`,{method:'POST'});const p=await r.json();if(!r.ok)throw new Error(p.error||`HTTP ${r.status}`);toast(`PR package verified: ${p.pr.branch}. Human merge control retained.`)}catch(err){toast(`PR gate closed: ${String(err?.message??err)}`)}});$('#payDemo')?.addEventListener('click',()=>toast('Payment-timeout experiment replayed.'));addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()})}
function mobile(){$('#menu')?.addEventListener('click',()=>{const b=$('#menu'),n=$('#navlinks');const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));n?.classList.toggle('mobile-open',!open)})}
function agentCycle(){if(reducedMotion)return;const rows=$$('#agentList li');let idx=0;setInterval(()=>{rows.forEach((r,i)=>{const dot=$('i',r),s=$('small',r);if(i===idx){dot.className='';s.textContent='Running'}else if(i<idx){dot.className='ok';s.textContent='Verified'}});idx=(idx+1)%rows.length},1350)}

reveal();counters();scrollMotion();cycleEngines();cards();reportTabs();steer();actions();mobile();agentCycle();typeStatus();rotateLine();
