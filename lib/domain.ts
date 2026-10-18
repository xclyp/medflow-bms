import { BusinessError, requireValue as ok, textValue as text, integer, uid, find } from './contracts.ts';
import type { Domain, DomainState, Context, Command, Envelope, Row } from './contracts.ts';
type Rate=Row&{name:string;customer:string;eventType:string;basis:string;unitCents:number;active:boolean};
type Charge=Row&{customer:string;amountCents:number;billId:string;eventId:string;rateId:string};
type Bill=Row&{reference:string;customer:string;amountCents:number;paidCents:number;status:string};
const rows=<T extends Row=Row>(s:DomainState,k:string)=>s.collections[k] as T[];
const get=<T extends Row=Row>(s:DomainState,k:string,id:unknown)=>find(s,k,id) as T;
const money=(v:unknown,label='金额（分）',min=1)=>integer(v,label,min,1_000_000_000_000);
function unique(s:DomainState,k:string,field:string,value:unknown){ok(!rows(s,k).some(r=>r[field]===value),'参考号或名称重复','DUPLICATE_REFERENCE');}
function parseIds(value:unknown){let data=value;if(typeof data==='string'){try{data=JSON.parse(data);}catch{throw new BusinessError('费用编号须为JSON数组');}}ok(Array.isArray(data)&&data.length>0&&data.length<=500,'请选择1至500条费用');const ids=data.map(v=>text(v,'费用编号'));ok(new Set(ids).size===ids.length,'费用编号不可重复');return ids;}
const initial=():DomainState=>({initialized:false,mode:'empty',outbox:[],collections:{rates:[],events:[],charges:[],bills:[],billLines:[],payments:[]}});
function apply(s:DomainState,c:Command,x:Context):string{
  if(c.action==='system.init'){ok(!s.initialized,'BMS已经初始化，不能覆盖');s.initialized=true;s.mode=c.demo===true?'demo':'empty';if(c.demo===true){rows(s,'rates').push({id:'RATE-SHIP',name:'演示出库操作费',customer:'*',eventType:'wms.outbound.shipped',basis:'per_unit',unitCents:20,active:true},{id:'RATE-DELIVER',name:'演示签收服务费',customer:'*',eventType:'tms.delivered',basis:'per_order',unitCents:500,active:true});}return 'BMS独立账单系统已初始化；仅接收业务事件后产生费用';}
  ok(s.initialized,'请先初始化BMS');
  if(c.action==='rate.create'){
    const name=text(c.name,'费率名称',100);unique(s,'rates','name',name);const eventType=text(c.eventType,'计费事件');ok(['wms.outbound.shipped','tms.delivered'].includes(eventType),'不支持的计费事件');const basis=text(c.basis,'计费方式');ok(['per_unit','per_order'].includes(basis),'计费方式须为按基本单位或按事件单据');const customer=typeof c.customer==='string'&&c.customer.trim()?text(c.customer,'客户'):'*';const unitCents=money(c.unitCents,'费率（分）');rows(s,'rates').push({id:uid('RATE-'),name,customer,eventType,basis,unitCents,active:true,at:x.now});return '费率已保存，仅影响后续事件；历史费用保留原费率快照';
  }
  if(c.action==='rate.disable'){const rate=get<Rate>(s,'rates',c.id);ok(rate.active,'费率已经停用');rate.active=false;rate.disabledReason=text(c.reason,'停用原因',200);return '费率已停用，历史费用不变';}
  if(c.action==='bill.create'){
    const reference=text(c.reference,'账单参考号',100);unique(s,'bills','reference',reference);const customer=text(c.customer,'客户');const ids=parseIds(c.chargeIds);const charges=ids.map(id=>get<Charge>(s,'charges',id));ok(charges.every(r=>r.customer===customer&&!r.billId),'费用客户不匹配或已被其他账单占用');let total=0;for(const charge of charges){total=money(total+charge.amountCents,'账单金额');}const id=uid('BILL-');rows(s,'bills').push({id,reference,customer,amountCents:total,paidCents:0,status:'draft',at:x.now});for(const charge of charges){charge.billId=id;rows(s,'billLines').push({id:uid('BL-'),billId:id,chargeId:charge.id,eventId:charge.eventId,rateId:charge.rateId,amountCents:charge.amountCents});}return '账单草稿已创建，未审核前不向ERP登记应收';
  }
  if(c.action==='bill.approve'){const bill=get<Bill>(s,'bills',c.id);ok(bill.status==='draft','仅草稿账单可审核');bill.status='approved';bill.approvedBy=x.actor;bill.approvedAt=x.now;x.emit('erp','bms.bill.approved',{billId:bill.id,customer:bill.customer,amountCents:bill.amountCents},bill.id);return '账单已审核，服务应收消息进入独立BMS发件箱';}
  if(c.action==='bill.void'){const bill=get<Bill>(s,'bills',c.id);ok(bill.status==='draft','仅草稿可作废；已审核账单须先设计ERP冲销协议，禁止单边撤销');bill.status='void';bill.voidReason=text(c.reason,'作废原因',200);bill.voidAt=x.now;for(const charge of rows<Charge>(s,'charges').filter(r=>r.billId===bill.id))charge.billId='';return '草稿账单已作废，费用重新可选，历史账单明细保留';}
  if(c.action==='payment.receive'){
    const bill=get<Bill>(s,'bills',c.billId);ok(['approved','partial'].includes(bill.status),'仅已审核且未收清账单可登记收款');const reference=text(c.reference,'银行/收款参考号',100);unique(s,'payments','reference',reference);const value=money(c.amountCents);ok(bill.paidCents+value<=bill.amountCents,'收款金额超过账单未收余额');const proof=text(c.proof,'收款凭据说明',300);const id=uid('PAY-');rows(s,'payments').push({id,billId:bill.id,reference,amountCents:value,proof,at:x.now,actor:x.actor});bill.paidCents+=value;bill.status=bill.paidCents===bill.amountCents?'paid':'partial';x.emit('erp','bms.payment.received',{billId:bill.id,reference,amountCents:value},bill.id);return '分次收款已保存，ERP服务费收款消息已排队；未直接修改ERP数据库';
  }
  throw new BusinessError('不支持的BMS动作','UNKNOWN_ACTION',400);
}
function receive(s:DomainState,e:Envelope,x:Context):string{
  ok(s.initialized,'请先初始化BMS');ok(e.target==='bms','消息目标不正确');ok((e.type==='wms.outbound.shipped'&&e.source==='wms')||(e.type==='tms.delivered'&&e.source==='tms'),'BMS仅接收WMS发货或TMS签收事件','UNKNOWN_MESSAGE');const p=e.payload;const customer=text(p.customer,'客户');const quantity=integer(p.quantity,'业务基本单位数量');const sourceId=text(e.type==='wms.outbound.shipped'?p.outboundId:p.shipmentId,'来源业务单据号');const orderId=text(p.orderId,'OMS订单号');const fingerprint=JSON.stringify({source:e.source,type:e.type,sourceId,customer,quantity,orderId});
  const previous=rows(s,'events').find(r=>r.id===e.id||r.businessKey===`${e.source}:${sourceId}`);if(previous){ok(previous.fingerprint===fingerprint,'同一来源业务事件内容冲突');return '计费事件已处理，未重复生成费用';}
  const rates=rows<Rate>(s,'rates').filter(r=>r.active&&r.eventType===e.type&&(r.customer==='*'||r.customer===customer));ok(rates.length>0,'没有适用费率，请配置后通过发件箱重试事件','RATE_NOT_READY');const items=rates.map(rate=>{const billedQuantity=rate.basis==='per_order'?1:quantity;const amountCents=money(billedQuantity*rate.unitCents,'事件费用金额');return {id:uid('FEE-'),eventId:e.id,businessKey:`${e.source}:${sourceId}`,sourceId,orderId,customer,rateId:rate.id,rateName:rate.name,basis:rate.basis,quantity:billedQuantity,unitCents:rate.unitCents,amountCents,billId:'',at:x.now};});
  rows(s,'events').push({id:e.id,businessKey:`${e.source}:${sourceId}`,source:e.source,type:e.type,sourceId,orderId,customer,quantity,fingerprint,chargeCount:items.length,at:e.at,receivedAt:x.now});rows(s,'charges').push(...items);return '真实收件事件已按当时费率生成费用，事件号及来源单据均防重复';
}
export default {system:'bms',initial,apply,receive} satisfies Domain;
