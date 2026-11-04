"use client";
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useZeb} from '@/providers/ZebProvider';
import {useAction} from '@/lib/useAction';
import {Container} from '@/components/layout/Container';
import {Button,ButtonLink} from '@/components/ui/Button';
import {FormField,Input,Select} from '@/components/ui/Field';
import {PageSkeleton,Callout} from '@/components/ui/Blocks';
import {NotConnectedNotice} from '@/components/layout/ModeBanner';
import {validateOnboarding} from '@/services/model';

export function Onboarding(){
 const {ready,live,isDemo,state,services}=useZeb();
 const router=useRouter();
 const {run,busy}=useAction();
 const [data,setData]=useState({businessName:'',handle:'',category:'',payoutUpi:'',beneficiaryName:''});
 const [showErrors,setShowErrors]=useState(false);
 const errors=validateOnboarding(state,data);

 if(!ready)return <Container className="py-12"><PageSkeleton/></Container>;
 if(!services || (live && live.error))return <Container className="py-12"><NotConnectedNotice/></Container>;
 if(live && !live.session.authenticated)return <Container className="max-w-lg py-12"><h1 className="font-display text-2xl">Create your merchant profile</h1><p className="my-4">Sign in with Noir Wallet or your merchant account first. Connecting a wallet alone does not create a session.</p><ButtonLink href="/login">Merchant sign in</ButtonLink></Container>;
 return (
   <Container className="max-w-xl py-12">
     <h1 className="font-display text-2xl">Set up your merchant checkout</h1>
     <p className="mt-2 mb-6 text-foreground-secondary">{live ? "Create a QR terminal and payment links. Testnet payments create nonredeemable receipts." : "Create your demo shop. Saved locally in your browser."}</p>
     <form className="panel space-y-5 p-6" noValidate onSubmit={async e=>{
       e.preventDefault();
       setShowErrors(true);
       if(Object.keys(errors).length||!services)return;
       const r=await run(()=>services.merchant.onboard(data),live ? 'Business profile created' : 'Demo shop created');
       if(r.ok)router.push('/app');
     }}>
       <FormField label="Business name" error={showErrors?errors.businessName:undefined}>{p=><Input {...p} value={data.businessName} maxLength={60} onChange={e=>setData({...data,businessName:e.target.value})}/>}</FormField>
       <FormField label="Merchant handle" error={showErrors?errors.handle:undefined}>{p=><Input {...p} value={data.handle} maxLength={24} onChange={e=>setData({...data,handle:e.target.value})}/>}</FormField>
       <FormField label="Business category" error={showErrors?errors.category:undefined}>{p=><Select {...p} value={data.category} onChange={e=>setData({...data,category:e.target.value})}><option value="">Choose a category</option>{['Food & beverage','Retail','Services','Other'].map(v=><option key={v}>{v}</option>)}</Select>}</FormField>
       {live ? (
         <Callout tone="info" title="Testnet only">No bank details are needed. TAZ cannot fund INR payouts or withdrawals.</Callout>
       ) : (
         <Callout tone="info" title="Demo mode">Payments are simulated locally.</Callout>
       )}
       <Button type="submit" isLoading={busy}>{live ? "Create merchant" : "Create demo merchant"}</Button>
     </form>
   </Container>
 );
}
