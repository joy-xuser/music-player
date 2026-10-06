# আগমনী সুর — local Invidious player

## চালানোর নিয়ম

1. Node.js 18 বা নতুন সংস্করণ ইনস্টল থাকতে হবে।
2. `start-local.bat` চালান।
3. Browser-এ `http://localhost:4173` খুলুন।

Project-টি playlist `PLTSRCGR4a75c`-এর public items Invidious API থেকে আনে। Track চাপলে local Node server audio-only stream relay করে এবং browser-এর Range/seek request forward করে। 403/502 বা timeout পাওয়া instance cooldown-এ যায়; একই track-এর জন্য format ও instance fallback চেষ্টা হয়। Media file download বা local cache করা হয় না।

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

Catalyst-এর AppSail Node.js runtime-এ app-টি চালানো যায়। AppSail listener port `X_ZOHO_CATALYST_LISTEN_PORT` থেকে নেওয়া হয়; `server.mjs` এখন `PORT` না থাকলে সেটি ব্যবহার করে। Catalyst CLI দিয়ে project initialize করে AppSail runtime হিসেবে Node.js নির্বাচন করুন, source/build path project root দিন, এবং startup command `npm start` সেট করুন। এরপর `catalyst deploy appsail` চালান।

Catalyst-এর বর্তমান AppSail free allowance 900 GB-minutes/month। 512 MB memory-তে এটি আনুমানিক 30 ঘণ্টা runtime; 10-minute keep-alive cron চালালে allowance দ্রুত শেষ হতে পারে। Free limit ছাড়ালে Catalyst-এর minimum project billing প্রযোজ্য হতে পারে—deploy-এর আগে বর্তমান usage/billing dashboard দেখুন। Catalyst-এ free signup হলেও Production-এ প্রথম deploy করার আগে payment method সেট করতে হয়।




