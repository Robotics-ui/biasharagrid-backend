// BiasharaGrid Stage 2 Backend - Daraja STK + Callback - LIVE PRODUCTION
// Secrets come from Render Environment Variables ONLY. Never in this file.
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ENV = process.env.DARAJA_ENV || 'sandbox';
const BASE = ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const SHORTCODE = process.env.DARAJA_SHORTCODE;
const PASSKEY = process.env.DARAJA_PASSKEY;
const CALLBACK = process.env.CALLBACK_URL;

function isLiveEnabled(){ return process.env.PAYMENTS_LIVE === 'true' && ENV === 'production'; }

async function getToken(){
  const auth = Buffer.from(process.env.DARAJA_CONSUMER_KEY + ':' + process.env.DARAJA_CONSUMER_SECRET).toString('base64');
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: 'Basic ' + auth } });
  const j = await r.json();
  if(!j.access_token) throw new Error('Daraja token failed: ' + JSON.stringify(j));
  return j.access_token;
}
function timestamp(){ return new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14); }

app.get('/health', (req,res)=>res.json({ ok:true, env:ENV, live:isLiveEnabled(), callback:CALLBACK }));

app.post('/api/subscriptions/stk-push', async (req,res)=>{
  try{
    const { phone, plan, amount, user_id } = req.body;
    if(!phone || !/^254\d{9}$/.test(phone)) return res.status(400).json({ error:'Phone must be 2547XXXXXXXX' });
    if(!amount || amount < 1) return res.status(400).json({ error:'Invalid amount' });
    if(!isLiveEnabled() && ENV === 'production') return res.status(403).json({ error:'Live payments disabled by kill-switch.' });
    const idempotency = 'BG-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    const token = await getToken();
    const ts = timestamp();
    const password = Buffer.from(SHORTCODE + PASSKEY + ts).toString('base64');
    const body = { BusinessShortCode: SHORTCODE, Password: password, Timestamp: ts, TransactionType: 'CustomerPayBillOnline', Amount: amount, PartyA: phone, PartyB: SHORTCODE, PhoneNumber: phone, CallBackURL: CALLBACK, AccountReference: 'BiasharaGrid-' + plan, TransactionDesc: 'BiasharaGrid subscription ' + plan };
    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, { method:'POST', headers:{ Authorization:'Bearer ' + token, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    await supabase.from('daraja_transactions').insert({ checkout_request_id: j.CheckoutRequestID || null, merchant_request_id: j.MerchantRequestID || null, phone, plan, amount, user_id: user_id || null, status:'PENDING', idempotency_key: idempotency, raw_request: body });
    await supabase.from('subscriptions').insert({ user_id: user_id || null, plan, amount, phone, status:'PENDING', idempotency_key: idempotency });
    res.json({ ok:true, checkoutRequestID: j.CheckoutRequestID, idempotency_key: idempotency, message:'STK Push sent. Customer must enter PIN.' });
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/daraja/callback', async (req,res)=>{
  try{
    const cb = req.body?.Body?.stkCallback;
    if(!cb) return res.json({ ResultCode:1, ResultDesc:'Invalid callback' });
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = cb;
    const { data: existing } = await supabase.from('daraja_transactions').select('*').eq('checkout_request_id', CheckoutRequestID).single();
    if(existing?.status === 'COMPLETED' || existing?.status === 'FAILED'){ return res.json({ ResultCode:0, ResultDesc:'Duplicate ignored' }); }
    let receipt=null, amount=null, phone=null, transDate=null;
    if(CallbackMetadata?.Item){ for(const it of CallbackMetadata.Item){ if(it.Name==='MpesaReceiptNumber') receipt=it.Value; if(it.Name==='Amount') amount=it.Value; if(it.Name==='PhoneNumber') phone=String(it.Value); if(it.Name==='TransactionDate') transDate=String(it.Value); } }
    await supabase.from('daraja_transactions').update({ status: ResultCode===0 ? 'COMPLETED':'FAILED', result_code: ResultCode, result_desc: ResultDesc, mpesa_receipt: receipt, amount: amount || existing?.amount, phone: phone || existing?.phone, transaction_date: transDate, raw_callback: req.body }).eq('checkout_request_id', CheckoutRequestID);
    await supabase.from('financial_audit_log').insert({ event_type:'DARAJA_CALLBACK', reference: CheckoutRequestID, details:{ ResultCode, ResultDesc, receipt, amount } });
    if(ResultCode===0){
      const { data: subs } = await supabase.from('subscriptions').select('*').eq('phone', phone).eq('status','PENDING').order('created_at',{ascending:false}).limit(1);
      const sub = subs?.[0];
      if(sub && sub.amount !== amount){ await supabase.from('financial_audit_log').insert({ event_type:'AMOUNT_MISMATCH', reference: CheckoutRequestID, details:{ expected: sub.amount, received: amount } }); return res.json({ ResultCode:0, ResultDesc:'Amount mismatch logged, not activated' }); }
      if(sub){ const expires = new Date(); expires.setMonth(expires.getMonth() + (sub.plan?.toLowerCase().includes('annual') ? 12 : 1)); await supabase.from('subscriptions').update({ status:'Active', mpesa_receipt: receipt, transaction_date: transDate, activated_at: new Date().toISOString(), expires_at: expires.toISOString() }).eq('id', sub.id); }
    } else {
      await supabase.from('subscriptions').update({ status: ResultCode===1032 ? 'CANCELLED':'FAILED' }).eq('phone', phone).eq('status','PENDING');
    }
    res.json({ ResultCode:0, ResultDesc:'Callback accepted' });
  }catch(e){ console.error(e); res.json({ ResultCode:1, ResultDesc:'Server error' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('BiasharaGrid backend on ' + PORT + ' env=' + ENV + ' live=' + isLiveEnabled()));
