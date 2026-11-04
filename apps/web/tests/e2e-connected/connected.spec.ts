/** Browser + HTTP + PostgreSQL. Chain observations are isolated test fixtures, never real money. */
import {expect,test,type Page} from '@playwright/test';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
const API='http://localhost:4200';
const MAIL=path.resolve(__dirname,'../../../../var/e2e-mail');
const idempotency=()=>`browser-${Date.now()}-${Math.random()}`;
async function fixturePayment(page:Page,id:string){
 const cfg=await (await page.request.get(`${API}/api/v1/public/config`)).json();
 expect(cfg.environment).toBe('demo'); // never inject into a real chain environment
 const token=await page.evaluate(id=>JSON.parse(localStorage.getItem('zebscan.checkoutAccess.v1')??'{}')[id]?.token,id);
 const r=await page.request.post(`${API}/api/v1/demo/checkout/${id}/simulate-deposit`,{headers:{authorization:`Bearer ${token}`,'idempotency-key':idempotency(),origin:'http://localhost:3200'},data:{kind:'exact',confirmations:3}});
 expect(r.status(),await r.text()).toBe(200);
}
async function merchant(page:Page){
 const handle=`shop-${Date.now().toString(36)}`;
 await page.goto('/login');await page.getByRole('tab',{name:'Create account'}).click();
 await page.getByLabel('Email',{exact:true}).fill(`${handle}@example.test`);await page.getByLabel('Password',{exact:true}).fill('correct horse battery staple');
 await page.getByRole('button',{name:'Create account',exact:true}).click();await page.waitForURL('**/onboarding');
 await page.getByLabel('Business name').fill('Browser Test Shop');await page.getByLabel('Merchant handle').fill(handle);await page.getByLabel('Business category').selectOption('Retail');
 await page.getByRole('button',{name:'Create merchant',exact:true}).click();await page.waitForURL('**/app');
 let link='';
 await expect.poll(()=>{for(const f of readdirSync(MAIL).sort().reverse()){const body=readFileSync(path.join(MAIL,f),'utf8');if(!body.includes(`${handle}@example.test`))continue;const m=body.match(/http:\/\/[^\s]+\/verify-email\?token=[^\s]+/);if(m){link=m[0];return true;}}return false;},{timeout:30000}).toBe(true);
 await page.goto(link);await expect(page.getByText('Your email is verified.')).toBeVisible();
}
test('guest Scan & Pay tracks authoritative confirmations and receipt without simulator controls',async({page})=>{
 await page.goto('/scan');await expect(page.getByText('Isolated test API · no real funds')).toBeVisible();
 await page.getByRole('tab',{name:'UPI ID'}).click();await page.getByLabel('Receiver UPI ID',{exact:true}).fill('corner.store@okaxis');await page.getByRole('button',{name:'Use this UPI ID'}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByLabel('Amount the receiver gets').fill('150');await page.getByRole('button',{name:/Lock quote/}).click();await page.waitForURL(/\/scan\/pi_/);
 const id=page.url().split('/').pop()!;
 await expect(page.getByRole('button',{name:/Simulate|Add confirmation/})).toHaveCount(0);
 await fixturePayment(page,id);await expect(page.getByText('ZEC payment verified',{exact:true}).first()).toBeVisible();
 await page.reload();await expect(page.getByText('ZEC payment verified',{exact:true}).first()).toBeVisible();
 await page.getByRole('link',{name:'View receipt',exact:true}).first().click();await expect(page).toHaveURL(/\/receipt\/rcp_/);
 await expect(page.getByText('corner.store@okaxis',{exact:true})).toHaveCount(0);
});
test('merchant authentication, terminal and one-time payment link use server facts',async({page,context})=>{
 await merchant(page);
 await page.goto('/app/terminal');await page.getByLabel('Amount (INR)').fill('500');await page.getByRole('button',{name:'Create checkout',exact:true}).click();
 await expect(page).toHaveURL(/c=pi_/);const terminal=new URL(page.url()).searchParams.get('c')!;
 await fixturePayment(page,terminal);await expect(page.getByText('ZEC payment verified',{exact:true}).first()).toBeVisible();
 await page.goto('/app/links/new');await page.getByLabel('Title',{exact:true}).fill('Single use browser payment');await page.getByLabel('Fixed amount',{exact:true}).fill('125');
 const created=page.waitForResponse(r=>r.url()===`${API}/api/v1/links`&&r.request().method()==='POST');await page.getByRole('button',{name:'Create link',exact:true}).click();const link=await (await created).json();await page.waitForURL(/\/app\/links\/lnk_/);
 const guest=await context.newPage();await guest.goto(`/pay/${link.slug}`);await guest.getByRole('button',{name:'Generate checkout'}).click();await guest.waitForURL(/\/checkout\/pi_/);const first=guest.url().split('/').pop()!;
 const second=await context.newPage();await second.goto(`/pay/${link.slug}`);await second.getByRole('button',{name:'Generate checkout'}).click();await second.waitForURL(/\/checkout\/pi_/);const secondId=second.url().split('/').pop()!;expect(secondId).not.toBe(first);
 // Opening two tabs consumes no use. Confirmation consumes exactly one.
 expect((await (await page.request.get(`${API}/api/v1/links/${link.id}`)).json()).successfulUses).toBe(0);
 await Promise.all([fixturePayment(guest,first),fixturePayment(second,secondId)]);
 await expect.poll(async()=>(await (await page.request.get(`${API}/api/v1/links/${link.id}`)).json()).successfulUses).toBe(1);
 await guest.reload();await second.reload();
 await expect.poll(async()=>((await guest.locator('body').innerText())+' '+(await second.locator('body').innerText())).includes('Refund')).toBe(true);
 await page.goto('/app/withdrawals/new');await expect(page.getByText('Withdrawals unavailable',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Request withdrawal'})).toHaveCount(0);
});
