# Production environment setup

This checklist covers the Cloudflare app at **https://app.vidxir.com**, deployed
from `feat/cloudflare-native`. Configuration was checked on **10 October 2026**.
Provider credentials were checked by name only; no real generation requests were
made. A configured key still needs valid provider billing, quota and model access.

## Already configured

Both Workers (`vidxir` and `vidxir-backend`) have these secrets:

- `ENCRYPTION_KEY`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_SECRET`
- `RESEND_API_KEY`
- `YOUTUBE_API_KEY`

The web Worker also has `RESEND_WEBHOOK_SECRET`. Google client ID, app URL,
email provider and sender are configured as regular variables. Resend receiving
uses `https://app.vidxir.com/api/webhooks/resend`.

D1, R2, Queues, Durable Objects and the rendering Container are already configured
through Wrangler bindings. No Postgres, Redis or S3 credentials are required.

## Where to add the remaining settings

In Cloudflare, open **Workers & Pages → the Worker → Settings → Variables and
Secrets**. Add API keys as **Secrets** and selectors/model names as **Text**
variables. Save and deploy the changes.

Add the AI/media settings below to **both `vidxir` and `vidxir-backend`**. The web
Worker checks capability availability and handles interactive requests; the backend
passes its settings to the Containers that run background generation.

Never put API keys in Wrangler `vars`, Git, or the static JV site. Keep non-secret
variables in `wrangler.jsonc` and `wrangler.native.jsonc` consistent with Cloudflare.

## AI and media providers still needed

None of the provider keys in this table were present on either Worker when checked.

| Feature | Secret | Text variable |
| --- | --- | --- |
| Research, scripts and metadata | `ANTHROPIC_API_KEY` | `AI_PROVIDER=anthropic` |
| Voiceovers | `ELEVENLABS_API_KEY` | `VOICE_PROVIDER=elevenlabs` |
| Stock footage | `PEXELS_API_KEY` | `VISUAL_PROVIDERS=pexels` |
| Captions using Whisper | `OPENAI_API_KEY` | `TRANSCRIPTION_PROVIDER=openai-whisper` |
| Music and sound effects | `FREESOUND_API_KEY` | `MUSIC_PROVIDER=freesound` |

For captions, Deepgram is an alternative: use `DEEPGRAM_API_KEY` with
`TRANSCRIPTION_PROVIDER=deepgram` instead of the Whisper configuration.

Keys are obtained from the respective provider accounts:

- Anthropic: <https://console.anthropic.com/settings/keys>
- ElevenLabs: <https://elevenlabs.io/app/settings/api-keys>
- Pexels: <https://www.pexels.com/api/new/>
- OpenAI: <https://platform.openai.com/api-keys>
- Freesound: <https://freesound.org/apiv2/apply/>
- Deepgram: <https://console.deepgram.com/>

The current code defaults are:

```env
ANTHROPIC_MODEL=claude-opus-5
ANTHROPIC_EFFORT=high
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Set `ANTHROPIC_MODEL` to a model your API account can access. Check available
models with Anthropic's [List Models API](https://platform.claude.com/docs/en/api/models/list).
The model default in the repository is not proof of account availability.

AWS Bedrock is also supported through `AI_PROVIDER=bedrock`, `BEDROCK_REGION`,
`BEDROCK_MODEL` and AWS credentials. It is an alternative configuration, not a
requirement when using the first-party Anthropic API.

## Optional AI video models

Stock-footage projects do not require all four AI video providers. Enable only
the models you intend to offer, and add their keys to both Workers.

| App model | Provider | Secret | Provider ID |
| --- | --- | --- | --- |
| Tal 1.0 | Alibaba Cloud / DashScope | `DASHSCOPE_API_KEY` | `qwen` |
| Tal 2.0 | MiniMax | `MINIMAX_API_KEY` | `minimax` |
| Tal 3.0 | Volcengine Ark / Seedance | `SEEDANCE_API_KEY` | `seedance` |
| Tal 3.1 | Google Gemini / Veo | `GEMINI_API_KEY` | `veo` |

The matching Text variable is an allowlist. To enable all four:

```env
VIDEO_GEN_PROVIDERS=qwen,minimax,seedance,veo
```

For only Tal 3.1, use `VIDEO_GEN_PROVIDERS=veo` and `GEMINI_API_KEY`. An empty
allowlist disables AI video generation; a key alone does not enable a model.
Google's YouTube OAuth credentials and `YOUTUBE_API_KEY` do not replace
`GEMINI_API_KEY`.

The code already supplies these defaults. Verify each model and regional endpoint
against your vendor account before relying on them in production.

| Provider | Video model variable/default | Image model variable/default |
| --- | --- | --- |
| DashScope | `DASHSCOPE_VIDEO_MODEL=wan2.2-t2v-plus` | `DASHSCOPE_IMAGE_MODEL=wan2.2-t2i-plus` |
| MiniMax | `MINIMAX_VIDEO_MODEL=MiniMax-Hailuo-02` | `MINIMAX_IMAGE_MODEL=image-01` |
| Seedance | `SEEDANCE_VIDEO_MODEL=dreamina-seedance-2-0-260128` | `SEEDANCE_IMAGE_MODEL=doubao-seedream-3-0-t2i-250415` |
| Veo | `GEMINI_VEO_MODEL=veo-3.1-generate-preview` | `GEMINI_IMAGE_MODEL=imagen-4.0-generate-001` |

Provider base URLs are configurable through `DASHSCOPE_BASE_URL`,
`MINIMAX_BASE_URL` and `SEEDANCE_BASE_URL`. See `.env.example` for the defaults.
`FAL_KEY` is deprecated and is not needed by the current direct integrations.

## Rendering

FFmpeg runs inside the Cloudflare Container. No Shotstack or Remotion key is
needed for the current renderer.

| Variable | `vidxir` | `vidxir-backend` |
| --- | --- | --- |
| `RENDER_PROVIDER` | `ffmpeg` (code default) | `ffmpeg` (code default) |
| `RENDER_EXECUTION` | `cloudflare` | `local` |

Keep `VIDXIR_USE_MOCK_PROVIDERS=false` and `VIDXIR_BLOCK_REAL_PUBLISH=false`
for real production generation and publishing. Selecting a `mock` voice, music
or transcription provider does not make that feature functional in production.

## Optional Stripe subscriptions

If using the app's Stripe billing integration, configure both Workers with:

| Setting | Type |
| --- | --- |
| `STRIPE_SECRET_KEY` | Secret |
| `STRIPE_WEBHOOK_SECRET` | Secret |
| `BILLING_PROVIDER=stripe` | Text |
| `STRIPE_PRICE_STUDIO` | Text: Studio Stripe price ID |
| `STRIPE_PRICE_SCALE` | Text: Scale Stripe price ID |

These settings enable Stripe billing; they are separate from AI generation and
do not implement JVZoo purchase entitlements.

## After configuration

Deploy both Workers and test a small project through research, scripting,
voiceover, visuals, captions and rendering. Then verify channel connection and
publishing separately. Keys existing in Cloudflare do not verify provider access,
model availability or successful end-to-end generation.

The regular test account has no purchased credits or subscription. Provider
configuration does not grant it entitlements; generation testing can use the
existing admin account with unlimited credits.

See [CLOUDFLARE.md](CLOUDFLARE.md) for deployment and [ADMIN.md](ADMIN.md) for
email, support and admin configuration. `.env.example` lists the full optional
configuration; you do not need to fill every entry.
