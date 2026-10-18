import test from 'node:test';
import assert from 'node:assert/strict';
import erp from '../lib/domain.ts';
import bms from '../lib/domain.ts';
import wcs from '../lib/domain.ts';
import type {Domain,DomainState,Envelope,Command,Context} from '../lib/contracts.ts';

function harness(domain:Domain){
 let state=domain.initial();let sequence=0;const emitted:Envelope[]=[];
 function invoke(kind:'apply'|'receive',input:Command|Envelope){const draft=structuredClone(state);const pending:Envelope[]=[];const context:Context={actor:'test-operator',now:'2026-10-18T04:00:00.000Z',emit:(target,type,payload,correlationId='')=>pending.push({id:`event-${domain.system}-${++sequence}`,source:domain.system,target,type,correlationId,at:'2026-10-18T04:00:00.000Z',payload})};const notice=kind==='apply'?domain.apply(draft,input as Command,context):domain.receive(draft,input as Envelope,context);state=draft;emitted.push(...pending);return notice;}
 return {get state(){return state;},emitted,do:(action:string,fields:Record<string,unknown>={})=>invoke('apply',{action,requestId:`request-${++sequence}`,...fields}),receive:(e:Envelope)=>invoke('receive',e)};
}
function message(source:Envelope['source'],target:Envelope['target'],type:string,payload:Record<string,unknown>,id=crypto.randomUUID()):Envelope{return {id,source,target,type,correlationId:'test-flow',at:'2026-10-18T04:00:00.000Z',payload};}
const first=(s:DomainState,k:string)=>s.collections[k][0];

test('BMS bills originate from actual received events with per-event and semantic deduplication',()=>{
 const h=harness(bms);h.do('system.init',{demo:true});const event=message('wms','bms','wms.outbound.shipped',{outboundId:'CK-1',orderId:'OMS-1',customer:'医院',quantity:5});h.receive(event);h.receive(event);h.receive({...event,id:'transport-retry-id'});assert.equal(h.state.collections.charges.length,1);assert.equal(first(h.state,'charges').amountCents,100);assert.throws(()=>h.receive({...event,id:'conflict-id',payload:{...event.payload,quantity:6}}),/冲突/);assert.throws(()=>h.receive(message('erp','bms','wms.outbound.shipped',event.payload)),/仅接收/);
});
test('BMS rejects events until an applicable rate exists rather than silently dropping charges',()=>{
 const h=harness(bms);h.do('system.init',{demo:false});const event=message('tms','bms','tms.delivered',{shipmentId:'SHIP-1',orderId:'OMS-1',customer:'医院',quantity:10});assert.throws(()=>h.receive(event),/费率/);assert.equal(h.state.collections.events.length,0);h.do('rate.create',{name:'签收',customer:'*',eventType:'tms.delivered',basis:'per_order',unitCents:500});h.receive(event);assert.equal(first(h.state,'charges').amountCents,500);assert.equal(first(h.state,'charges').quantity,1);
});
test('BMS draft void releases charges, approved bills cannot be unilaterally voided',()=>{
 const h=harness(bms);h.do('system.init',{demo:true});h.receive(message('wms','bms','wms.outbound.shipped',{outboundId:'CK-2',orderId:'OMS-2',customer:'医院',quantity:10}));const fee=first(h.state,'charges');h.do('bill.create',{reference:'BILL-1',customer:'医院',chargeIds:[fee.id]});const bill=first(h.state,'bills');assert.throws(()=>h.do('bill.create',{reference:'BILL-2',customer:'医院',chargeIds:[fee.id]}),/占用/);h.do('bill.void',{id:bill.id,reason:'重新核对'});assert.equal(first(h.state,'charges').billId,'');h.do('bill.create',{reference:'BILL-2',customer:'医院',chargeIds:[fee.id]});const approved=h.state.collections.bills[1];h.do('bill.approve',{id:approved.id});assert.equal(h.emitted.at(-1)?.type,'bms.bill.approved');assert.throws(()=>h.do('bill.void',{id:approved.id,reason:'不得单边撤销'}),/仅草稿/);
});
