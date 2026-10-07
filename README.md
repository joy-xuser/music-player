# আগমনী সুর — local Invidious player

## চালানোর নিয়ম

1. Node.js 18 বা নতুন সংস্করণ ইনস্টল থাকতে হবে।
2. `start-local.bat` চালান। একটি secure Windows passcode dialog আসবে; সেখানে admin passcode দিন। Server window চালু থাকা পর্যন্ত এটি বন্ধ করবেন না। Website-এর admin dialog-এ একই passcode দিন।
3. Browser-এ `http://localhost:4173` খুলুন।

Project-টি playlist `PLTSRCGR4a75c`-এর public items Invidious API থেকে আনে। Track চাপলে local Node server audio-only stream relay করে এবং browser-এর Range/seek request forward করে। 403/502 বা timeout পাওয়া instance cooldown-এ যায়; একই track-এর জন্য format ও instance fallback চেষ্টা হয়। Media file download বা local cache করা হয় না।

## Admin dashboard

Header-এর admin আইকনে passcode দিলে dashboard খুলবে। সেখানে category যোগ/নাম বদল/মুছে ফেলা, YouTube-এর একক গান বা playlist link থেকে metadata এনে যোগ করা, এবং public direct audio link-এর সঙ্গে নিজের title ও artist দিয়ে গান যোগ করা যায়। Local mode-এ dashboard-এর data `data/library.json`-এ থাকে। Catalyst AppSail-এ category ও added song `AagomoniLibrary` Data Store table-এ থাকে; প্রথম request-এ local seed file থেকে একবার data load হয়। ফলে যেকোনো device-এর admin edit একই server database-এ save হয়। খোলা browser-এ অন্য device-এর change সর্বোচ্চ ৩০ সেকেন্ডের মধ্যে sync হয়। কোনো category-তে গান থাকলে সেটি মুছতে হলে আগে গানগুলো সরাতে হবে।

YouTube metadata Invidious instance-এর API থেকে আসে, তাই public instance down বা YouTube block করলে import ব্যর্থ হতে পারে। নিজের audio URL-টি public direct media file হওয়া দরকার; Drive share/preview link সবসময় direct audio stream দেয় না।

Passcode verification সফল হলেও dashboard না খুললে browser-এর console/network error দেখুন। `Failed to fetch` মানে browser API server-এ পৌঁছায়নি: `start-local.bat` চালু আছে কি না দেখুন, server window বন্ধ না করে রাখুন, তারপর `http://localhost:4173` refresh করুন। ভুল passcode হলে page Bengali error দেখাবে; server-এ passcode configure না থাকলে setup error আসবে। Server code বদলানোর পর পুরোনো Node process বন্ধ করে `start-local.bat` দিয়ে আবার চালাতে হবে।

Public Invidious instance বদলাতে বা সাময়িকভাবে বন্ধ হতে পারে। Player Companion-এর PO Token error পেলে ৩০–৬০ সেকেন্ড অপেক্ষা করে আবার চেষ্টা করুন। চাইলে নিজের বা অন্য reachable instance ব্যবহার করতে `INVIDIOUS_INSTANCE` সেট করে app চালু করুন। PowerShell উদাহরণ:

```powershell
$env:INVIDIOUS_INSTANCE = 'https://your-invidious-instance.example'
.\start-local.bat
```

নিজের local instance হলে `http://localhost:3000` দেওয়া যায়। Local mode-এ website server `127.0.0.1`-এ bind করে।

## Render-এ deploy

এই app-টিকে Render-এর **Web Service** হিসেবে deploy করুন; আলাদা Static Site দরকার নেই, কারণ একই Node server frontend ও `/api/*` endpoint দুটোই serve করে। GitHub repository-টি Render-এ connect করে:

- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node.js 18 বা নতুন

Render-এর `PORT` environment variable থাকলে server `0.0.0.0`-এ bind করবে; local run-এ default bind `127.0.0.1` থাকবে। চাইলে Render dashboard-এর environment variables-এ `INVIDIOUS_INSTANCE` যোগ করে নিজের Invidious instance বেছে নিন।

Free Web Service ১৫ মিনিট inbound traffic না পেলে sleep করে; পরের request-এ জাগতে প্রায় এক মিনিট লাগতে পারে। Audio relay-তে বাইরের stream traffic হয়, আর Invidious public instance-গুলোও rate-limit বা বন্ধ থাকতে পারে।

Keep-alive bot/cron বাইরে থেকে প্রতি ১০ মিনিটে `https://<your-service>.onrender.com/health`-এ GET request পাঠাতে পারে। App-এর ভেতরের timer নিজে থেকে Render-এ inbound request তৈরি করে না; cron runner যদি একই sleeping service-এ থাকে, সেটিও ঘুমিয়ে পড়বে। Render যেকোনো সময় instance restart করতে পারে, তাই এই ping-কে uptime guarantee হিসেবে ধরবেন না।

## Zoho Catalyst-এ deploy

Catalyst-এর AppSail Node.js runtime-এ app-টি চালানো যায়। AppSail listener port `X_ZOHO_CATALYST_LISTEN_PORT` থেকে নেওয়া হয়; `server.mjs` এখন `PORT` না থাকলে সেটি ব্যবহার করে এবং AppSail-এ স্বয়ংক্রিয়ভাবে Catalyst Data Store ব্যবহার করে। Shared `AagomoniLibrary` table-এর `RecordId` (unique, mandatory, Var Char), `Kind` (mandatory, Var Char), `CategoryId` (Var Char), `Position` (mandatory, Int), এবং `Payload` (mandatory, Text) columns প্রয়োজন। Catalyst CLI দিয়ে project initialize করে AppSail runtime হিসেবে Node.js নির্বাচন করুন, source/build path project root দিন, startup command `npm start` সেট করুন, তারপর `catalyst deploy appsail` চালান। Admin passcode AppSail environment variable `ADMIN_PASSCODE`-এ রাখতে হবে।

Catalyst-এর বর্তমান AppSail free allowance 900 GB-minutes/month। 512 MB memory-তে এটি আনুমানিক 30 ঘণ্টা runtime; 10-minute keep-alive cron চালালে allowance দ্রুত শেষ হতে পারে। Free limit ছাড়ালে Catalyst-এর minimum project billing প্রযোজ্য হতে পারে—deploy-এর আগে বর্তমান usage/billing dashboard দেখুন। Catalyst-এ free signup হলেও Production-এ প্রথম deploy করার আগে payment method সেট করতে হয়।

Admin passcode source code-এ রাখা হয় না। Local run-এ `start-local.bat` secure prompt থেকে process-এর জন্য নেয়। Deploy করলে AppSail-এর Environment Variables-এ `ADMIN_PASSCODE` সেট করতে হবে।



