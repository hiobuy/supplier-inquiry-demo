import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { fakeGateway, KEY_A, SECRET_A } from './test/helpers.mjs';
const fake = fakeGateway();
export default defineConfig({
  plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{
    bindings:{PUBLIC_ORIGIN:'https://demo.example',HIOBUY_APP_ID:'app_a',HIOBUY_API_KEY:KEY_A,HIOBUY_WEBHOOK_SECRET:SECRET_A,HIOBUY_PRODUCT_ID:'673124809943',MEDIA_ENABLED:'false'},
    serviceBindings:{HIOBUY_GATEWAY:async request=>{
      const u=new URL(request.url);
      if(u.pathname==='/__fixture/reset'){fake.calls.length=0;fake.conversations.clear();fake.idem.clear();fake.attachments.clear();fake.ratings.clear();fake.seq=0;fake.down=false;return Response.json({ok:true});}
      const body=request.method==='GET'||request.method==='HEAD'?undefined:await request.text();
      let result=await fake.fetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body});
      if(u.pathname==='/v1/ask/identity'&&result.status===200){const data=await result.json();data.data.api_key.environment='production';result=Response.json(data);}
      return result;
    }},
  }})],
  test:{include:['test/worker/*.test.mjs'],testTimeout:30000},
});
