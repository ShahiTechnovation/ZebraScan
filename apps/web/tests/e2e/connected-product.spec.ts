import {expect,test} from '@playwright/test';
for(const width of [360,768,1440]){
 test(`public product fails closed without a configured API at ${width}px`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width,height:900});
  for(const route of ['/','/scan','/login','/onboarding','/pay/unknown','/app/terminal','/app/links']){
   await page.goto(route);await expect(page.getByRole('link',{name:'Zeb Scan home'}).first()).toBeVisible();
   await expect(page.getByText(/Payments temporarily unavailable/).first()).toBeVisible();
   await expect(page.getByRole('button',{name:/Simulate|Explore demo|Reach required confirmations/})).toHaveCount(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
 });
}
test('guest QR rejects arbitrary URLs and wallet absence is explicit',async({page})=>{
 await page.goto('/scan');await page.getByRole('tab',{name:'Paste',exact:true}).click();
 await page.getByLabel("QR data").fill('https://attacker.invalid/payment');
 await page.getByRole('button',{name:/Read QR|Parse/}).click();
 await expect(page.getByText("Can't use this QR",{exact:true})).toBeVisible();
 await page.goto('/login');await page.getByRole('button',{name:'Sign in with Noir Wallet'}).click();
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByText(/not installed|Install it/i).first()).toBeVisible();
});
