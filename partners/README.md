# JV static site

Deploy this folder as a separate Cloudflare Pages project named `vidxir-jv`,
using production branch `feat/jv-partners-page`, root directory `partners`,
build command `exit 0`, and output directory `.`. The live join page is
`https://vidxir.com/partners/join`. The API allows the `vidxir.com` and
`www.vidxir.com` origins as well as the optional `jv.vidxir.com` domain.
Do not deploy the repository root's app Worker for this site.

Preview locally with:

```sh
python3 -m http.server 3002 --bind 127.0.0.1 --directory partners
```

The join form posts to `https://app.vidxir.com/api/subscribe`, provided by the
app's `feat/cloudflare-native` branch. Deploy that endpoint before testing the
form. It reuses the existing Resend segment **Lyrixsa – JV Launch Updates**;
no new segment or API key on this static site is required. The app Worker
needs a full-access `RESEND_API_KEY` in the same Resend account as that segment.

The form displays success only after the API confirms the contact was saved
and a welcome email was added to the durable outbox. The email uses the app's
shared account template and signs off with "The Vidxir AI team". Repeated
submissions do not send duplicate confirmation emails.
Existing contacts retain their unsubscribe preference. Sharing this segment
means Lyrixa and Vidxir JV contacts use the same broadcast recipient list.
When changing the Pages project name/domain, update the API's origin allowlist.

Both pages also load `livechat.js` and `livechat.css` for LiveChat license
**19969473**, anchored at the bottom right on desktop and mobile. Keep these
assets in sync with the app branch's `public/livechat.js` and `public/livechat.css`.
