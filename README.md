# Airlock

Ask any AI without leaking your secrets. Airlock finds private details in your prompt **on your device**, swaps them for placeholders, and only then lets anything reach the cloud. Answers come back with your real details restored locally.

Built for #BuildHybridAI 2026 with **Firebase AI Logic hybrid inference** (Web, Chrome desktop, Gemini Nano).

## How it uses Firebase AI Logic
| Step | Mode | Why |
|---|---|---|
| Find private details (names, companies, salaries, project names) with structured JSON output | `ONLY_ON_DEVICE` | Sees raw text, so it must never fall back to the cloud |
| Answer short or simple prompts | `ONLY_ON_DEVICE` | Free, private, works offline. Nothing is sent |
| Answer long or complex prompts | `PREFER_IN_CLOUD` | Gets masked text only. If offline, falls back to on-device |

Deterministic rules (Aadhaar, PAN, phone, email, UPI, IFSC, Luhn-checked cards, API keys) run first. The on-device model adds what regex cannot: names, employers, salaries, internal project names. A router explains every decision, a meter shows exactly how many bytes left the device, and an inference log lists every model call with its mode, where it ran and how long it took.

If the on-device model is not available (Firefox, mobile, old hardware), Airlock does not guess. It stops and asks you to review: click any word it missed, then send the masked version. The same review step can be switched on any time with "Check before sending".

Also uses Firebase App Check (required) and Firebase Hosting.

## Run it
1. Chrome desktop 139+, with `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` enabled.
2. `npm install`, copy `.env.example` to `.env` and fill it in.
3. `npm run dev`, open the app, copy the App Check debug token from the console, register it in the Firebase console.
4. `npm run build && firebase deploy --only hosting`

## License
Apache-2.0
