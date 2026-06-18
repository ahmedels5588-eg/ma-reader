# MA Reader Web

نسخة Web MVP عربية RTL لتحويل PDF والصور إلى Word أو TXT باستخدام Gemini.

## الخصوصية

- لا توجد قاعدة بيانات.
- لا يتم تخزين ملفات المستخدم على الخادم.
- PDF يتحول إلى صور داخل المتصفح، ولا يتم رفع ملف PDF كاملًا.
- يرسل التطبيق صورة الصفحة الحالية فقط إلى Netlify Function عند التحويل.
- مفتاح Gemini API يحفظ محليًا في `localStorage` عند اختيار المستخدم لذلك.
- المفتاح لا يطبع في السجلات ولا يرسل إلا مع طلب التحويل.

## التشغيل المحلي

```bash
npm install
npm run dev
```

لاختبار Netlify Function محليًا استخدم Netlify CLI:

```bash
netlify dev
```

## البناء

```bash
npm run build
```

## النشر على Netlify

إذا كان هذا المجلد داخل مستودع أكبر، اضبط إعدادات الموقع على:

- Base directory: `ma-reader-web`
- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

ملف `netlify.toml` يحتوي نفس الإعدادات عند استخدام هذا المجلد كجذر مشروع Netlify.

## الحدود الحالية للـ MVP

- يرسل طلب Gemini واحد فقط في كل مرة.
- زر الإيقاف يمنع بدء الصفحات التالية، وقد يوقف الطلب الحالي إن أمكن عبر المتصفح.
- Word يحافظ على النص والجداول والتسطير/الغامق/المائل عندما يرجعها Gemini في `runs`.
- TXT لا يطلب تنسيقات بصرية من Gemini.
