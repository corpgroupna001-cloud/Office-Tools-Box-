/* Company structure / shift Gantt, outgoing email monitoring, extended editor. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(action, data = {}) {
    const r = await adminFetch({ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action,...data}) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'Request failed');
    return out;
  }
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const time = t => { const [h,m] = String(t || '00:00').split(':').map(Number); return h * 60 + m; };
  const clock = t => { const h = Number(String(t).slice(0,2)); return `${h%12 || 12}:${String(t).slice(3,5)} ${h>=12?'PM':'AM'}`; };
  const range = s => s ? `${clock(s.start_time)} – ${clock(s.end_time)}${time(s.end_time)<=time(s.start_time)?' (+1 day)':''}` : 'No shift configured';
  let people = [], shifts = [], mailPage = 0, mailMore = false, active = '', editorEmployee;
  const companyPanel = document.createElement('section');
  companyPanel.id='company-panel'; companyPanel.className='hidden ws-management';
  companyPanel.innerHTML=`<h1>Company structure</h1><p>Company → department → employees. Scheduled shifts in IST; overnight shifts continue into the next day. This is a schedule, not a record of actual punches.</p>
    <div class="mg-toolbar"><label>Shift start date<input id="mg-date" type="date"></label><label>Company<select id="mg-company"><option value="">All companies</option>${WSCompanies.companies.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label><label>Find employee<input id="mg-search" type="search" placeholder="Name, department or code"></label><button id="mg-refresh">Refresh</button></div>
    <p id="mg-summary" aria-live="polite"></p><div id="mg-gantt"></div>`;
  document.querySelector('.admin-main').append(companyPanel);
  $('mg-date').value=today();
  function bar(s, secondary=false) {
    if (!s) return '';
    let start=time(s.start_time), end=time(s.end_time); if(end<=start) end+=1440;
    return `<div class="mg-track"><span class="mg-bar ${secondary?'secondary':''}" style="left:${start/2160*100}%;width:${(end-start)/2160*100}%" title="${esc(s.name)} · ${esc(range(s))}">${esc(range(s))}</span></div>`;
  }
  function renderGantt() {
    if (!$('mg-date').value) return;
    const day = new Date($('mg-date').value+'T12:00:00+05:30').getUTCDay() || 7;
    const filter=$('mg-company').value, search=$('mg-search').value.trim().toLowerCase();
    const left=people.filter(p=>p.status==='inactive').length;
    const visible=people.filter(p=>p.status!=='inactive' && (!filter || p.company===filter) && (!search || [p.full_name,p.email,p.department,p.employee_code].join(' ').toLowerCase().includes(search)));
    const names = [...new Set([...WSCompanies.companies,...visible.map(p=>p.company || 'Company assignment needed')])].filter(c=>!filter || c===filter);
    let rows='', count=0;
    for(const company of names) {
      const members=visible.filter(p=>(p.company || 'Company assignment needed')===company).sort((a,b)=>(a.department||'').localeCompare(b.department||'')||(a.full_name||a.email||'').localeCompare(b.full_name||b.email||''));
      if(search && !members.length) continue;
      const defaultShift=WSCompanies.resolveShift({company},shifts);
      rows+=`<tr class="mg-company"><td>${esc(company)}<small>${members.length} employees</small></td><td>${bar(defaultShift)}</td></tr>`;
      let department;
      for(const p of members) {
        const dept=p.department || 'Department not assigned';
        if(dept!==department) { rows+=`<tr class="mg-dept"><td>${esc(dept)}</td><td></td></tr>`; department=dept; }
        const s=WSCompanies.resolveShift(p,shifts), s2=shifts.find(x=>String(x.id)===String(p.shift2_id));
        const manager=people.find(x=>x.id===p.manager_id);
        const scheduled=s && (!s.working_days || s.working_days.includes(day));
        const secondScheduled=s2 && (!s2.working_days || s2.working_days.includes(day));
        rows+=`<tr><td>${esc(p.full_name || p.email)}<small>${esc(p.job_title || p.employee_code || 'Employee')} · ${p.is_wfh?'WFH':'Office'}</small>${manager?`<small>Reports to ${esc(manager.full_name || manager.email)}</small>`:''}<small>${s?.company_default?'Company default':p.shift_id?'Assigned shift':'General default'}</small></td><td>${scheduled?bar(s):'<small>Weekly off / no shift</small>'}${secondScheduled?bar(s2,true)+`<small>Secondary: ${esc(p.company2)}</small>`:''}</td></tr>`;
        count++;
      }
    }
    $('mg-summary').textContent=`${count} employees shown · ${$('mg-date').value} · Next-day hours are marked +1.${left?` ${left} offboarded employee${left>1?'s are':' is'} not shown.`:''} Holidays and leave are available in their respective tabs.`;
    $('mg-gantt').innerHTML=`<div class="mg-scroll"><table class="mg-table mg-gantt"><thead><tr><th>Organization / employee</th><th><div class="mg-scale">${['00','03','06','09','12','15','18','21','00 +1','03 +1','06 +1','09 +1','12 +1'].map(t=>`<span>${t}</span>`).join('')}</div></th></tr></thead><tbody>${rows || '<tr><td colspan="2">No matching employees.</td></tr>'}</tbody></table></div>`;
  }
  async function loadCompany() {
    $('mg-summary').textContent='Loading company structure…';
    try { const [p,s] = await Promise.all([api('employees'),api('shift_list')]); people=p.employees; shifts=s.shifts; renderGantt(); }
    catch(e) { $('mg-summary').textContent=e.message; }
  }
  ['mg-date','mg-company'].forEach(id=>$(id).addEventListener('change',renderGantt));
  $('mg-search').addEventListener('input',renderGantt); $('mg-refresh').addEventListener('click',loadCompany);

  const mailPanel=document.createElement('section'); mailPanel.id='email-panel'; mailPanel.className='hidden ws-management';
  mailPanel.innerHTML=`<h1>Email monitoring</h1><p>Outgoing WorkSuite messages. “SMTP accepted” means the mail server accepted the message; it does not confirm inbox delivery or reading. Attendance history includes skipped and pending notifications.</p>
    <div id="mg-mail-health"></div><div class="mg-toolbar"><label>History<select id="mg-mail-source"><option value="attendance">Attendance notifications</option><option value="system">Other system emails</option></select></label><label>From (IST)<input id="mg-mail-from" type="date"></label><label>To (IST)<input id="mg-mail-to" type="date"></label><label>Status<select id="mg-mail-status"></select></label><button id="mg-mail-refresh">Refresh</button></div>
    <p id="mg-mail-message" aria-live="polite"></p><div id="mg-mail-logs"></div><div class="mg-toolbar"><button id="mg-mail-prev">Previous</button><span id="mg-mail-page"></span><button id="mg-mail-next">Next</button></div>`;
  document.querySelector('.admin-main').append(mailPanel);
  $('mg-mail-to').value=today(); $('mg-mail-from').value=new Date(Date.parse(today())-6*86400000).toISOString().slice(0,10);
  function statuses() { const system=$('mg-mail-source').value==='system'; $('mg-mail-status').innerHTML='<option value="">All statuses</option>'+ (system?['accepted','failed']:['sent','failed','pending','skipped']).map(s=>`<option value="${s}">${s==='sent'||s==='accepted'?'SMTP accepted':s}</option>`).join(''); }
  statuses();
  function badge(s) { return `<span class="mg-status ${s==='sent'||s==='accepted'?'ok':s==='failed'?'bad':''}">${esc(s==='sent'||s==='accepted'?'SMTP accepted':s || 'Not recorded')}</span>`; }
  function stamp(value) { return value ? new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}) : '—'; }
  async function loadMail() {
    $('mg-mail-message').textContent='Loading…'; $('mg-mail-prev').disabled=true; $('mg-mail-next').disabled=true;
    try {
      const d=await api('mail_logs',{source:$('mg-mail-source').value,from:$('mg-mail-from').value,to:$('mg-mail-to').value,status:$('mg-mail-status').value,page:mailPage});
      mailMore=d.more;
      $('mg-mail-logs').innerHTML=`<div class="mg-scroll"><table class="mg-table"><thead><tr><th>Time (IST)</th><th>Employee / recipient</th><th>Message</th><th>Status</th><th>Details</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${esc(stamp(r.log_datetime || r.created_at))}</td><td>${esc(r.employee_name || r.recipient || r.email_to || 'No recipient')}<small>${esc(r.employee_code || r.email_to || r.company || '')}</small></td><td>${esc(r.event_type || r.category || r.direction || 'Attendance')}</td><td>${badge(r.email_status || r.status)}</td><td>${esc(r.email_error || r.reason || '—')}<small>${r.emailed_at?'Attempt: '+esc(stamp(r.emailed_at)):esc(r.sender || '')}</small></td></tr>`).join('') || '<tr><td colspan="5">No emails in this date range.</td></tr>'}</tbody></table></div>`;
      $('mg-mail-message').textContent=d.source==='system'?'System audit starts after the database migration and this release. Password recovery mail sent by Supabase is outside this SMTP history.':'';
      $('mg-mail-page').textContent=`Page ${mailPage+1}`; $('mg-mail-prev').disabled=mailPage===0; $('mg-mail-next').disabled=!mailMore;
    } catch(e) { $('mg-mail-message').textContent=e.message; $('mg-mail-logs').innerHTML=''; }
  }
  async function loadHealth() {
    try {
      const d=await api('mail_status');
      $('mg-mail-health').innerHTML=`<div class="mg-scroll"><table class="mg-table"><thead><tr><th>Company</th><th>Sender mailbox</th><th>Configuration</th></tr></thead><tbody>${d.companies.map(c=>`<tr><td>${esc(c.company)}</td><td>${esc(c.from || 'Not configured')}</td><td>${badge(c.ok && d.smtp.host && d.smtp.pass?'configured':'failed')} ${esc(c.detail || (!d.smtp.host || !d.smtp.pass?'SMTP settings missing':''))}</td></tr>`).join('')}</tbody></table></div><p>Last 7 days: ${Object.entries(d.last7.tally).map(([s,n])=>`${esc(s)}: ${n}`).join(' · ') || 'No recorded attendance emails'}</p>`;
    } catch(e) { $('mg-mail-health').textContent=e.message; }
  }
  ['mg-mail-from','mg-mail-to','mg-mail-status','mg-mail-source'].forEach(id=>$(id).addEventListener('change',()=>{mailPage=0;if(id==='mg-mail-source')statuses();loadMail();}));
  $('mg-mail-refresh').addEventListener('click',()=>{mailPage=0;loadMail();loadHealth();});
  $('mg-mail-prev').addEventListener('click',()=>{if(mailPage>0){mailPage--;loadMail();}});
  $('mg-mail-next').addEventListener('click',()=>{if(mailMore){mailPage++;loadMail();}});
  document.querySelectorAll('.admin-tab').forEach(tab=>tab.addEventListener('click',()=>{
    active=tab.dataset.tab; companyPanel.classList.toggle('hidden',active!=='company');mailPanel.classList.toggle('hidden',active!=='email');
    if(active==='company')loadCompany(); if(active==='email'){loadHealth();loadMail();}
  }));
  window.addEventListener('admin-refresh',()=>{if(active==='company')loadCompany();if(active==='email'){loadHealth();loadMail();}});

  const fieldSpec=[['email','Login / notification email','email'],['company','Company','company'],['employee_code','Biometric employee code','text'],['department','Department','text'],['job_title','Job title','text'],['phone','Phone','tel'],['joining_date','Joining date','date'],['manager_id','Reports to','manager'],['shift_id','Primary shift','shift'],['company2','Secondary company','company2'],['shift2_id','Secondary shift','shift2']];
  window.WSAdminPeople={
    async open(emp) {
      editorEmployee=emp; $('edit-emp-save').disabled=true; $('mg-edit-fields').textContent='Loading account settings…';
      try {
        const data=await api('shift_list');
        const options=(items,selected)=>items.map(([v,label])=>`<option value="${esc(v)}" ${String(v)===String(selected??'')?'selected':''}>${esc(label)}</option>`).join('');
        const orgReady='department' in emp;
        $('mg-edit-fields').innerHTML=fieldSpec.map(([key,label,type])=>{
          let input;
          const value=emp[key]??'';
          const disabled=!orgReady && ['department','job_title','phone','joining_date','manager_id'].includes(key);
          if(type.startsWith('company')) {
            const names=[...new Set([...WSCompanies.companies,...(value?[value]:[])])];
            input=`<select id="mg-edit-${key}">${options([['',type==='company2'?'No secondary company':'Select company'],...names.map(c=>[c,c])],value)}</select>`;
          } else if(type.startsWith('shift')) input=`<select id="mg-edit-${key}">${options([['',type==='shift'?'Company default':'No secondary shift'],...data.shifts.map(s=>[s.id,`${s.name} · ${range(s)}`])],value)}</select>`;
          else if(type==='manager') input=`<select id="mg-edit-${key}" ${disabled?'disabled':''}>${options([['','No manager assigned'],...data.employees.filter(p=>p.id!==emp.id).map(p=>[p.id,p.full_name || p.email])],value)}</select>`;
          else input=`<input id="mg-edit-${key}" type="${type}" value="${esc(value)}" ${disabled?'disabled':''}>`;
          return `<label>${label}${input}</label>`;
        }).join('')+['is_wfh','req_mobile','req_laptop','req_tab'].map((key,i)=>`<label class="mg-check"><input id="mg-edit-${key}" type="checkbox" ${emp[key]?'checked':''}>${['Work from home','Require mobile check-in','Require laptop check-in','Require tablet check-in'][i]}</label>`).join('');
        $('mg-edit-note').textContent=(orgReady?'':'Apply supabase-admin-management-migration.sql to enable employment details. ')+ (emp.status==='inactive'?`This employee is offboarded${emp.exit_date?' as of '+emp.exit_date:''} and cannot sign in; use the ↩️ button in the employee list to bring them back. `:'')+ 'Changing email immediately changes the login address. Leave primary shift on Company default to use the company schedule. Changes apply to future punches; historical punches are not rewritten.';
        $('edit-emp-save').disabled=false;
      } catch(e) { $('mg-edit-fields').textContent=e.message; }
    },
    values() {
      if(!editorEmployee) return {};
      const data={};
      for(const [key] of fieldSpec) { const el=$('mg-edit-'+key); if(el && !el.disabled) data[key]=el.value.trim() || null; }
      for(const key of ['is_wfh','req_mobile','req_laptop','req_tab']) data[key]=$('mg-edit-'+key).checked;
      return data;
    }
  };
}());
