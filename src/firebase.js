import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';

const env = import.meta.env;
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

// App Check is required by Firebase AI Logic. On localhost we use the debug provider.
if (env.DEV || env.VITE_APPCHECK_DEBUG === 'true') {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN || true;
}
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider(env.VITE_RECAPTCHA_SITE_KEY || 'missing-site-key'),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app, { backend: new GoogleAIBackend() });

const lang = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

// Structured output: the on-device model must answer with this JSON shape.
export const ENTITY_TYPES = ['PERSON', 'ORG', 'LOCATION', 'MONEY', 'PROJECT'];
const entitySchema = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ENTITY_TYPES },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['entities'],
};

// Three models, three deliberate modes:
// 1) Detector reads RAW text, so it may only ever run on-device. ONLY_ON_DEVICE throws
//    instead of silently falling back to the cloud, which would leak the raw text.
export const detector = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: { createOptions: lang, promptOptions: { responseConstraint: entitySchema } },
});
// 2) Local answerer also sees RAW text. Same rule: on-device or fail.
export const localModel = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: { createOptions: lang },
});
// 3) Cloud answerer only ever sees MASKED text. PREFER_IN_CLOUD means that if the user is
//    offline, the SDK falls back to the on-device model, which is safe for masked text too.
export const cloudModel = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_IN_CLOUD,
  inCloudParams: { model: 'gemini-3.5-flash-lite' },
  onDeviceParams: { createOptions: lang },
});

export async function deviceStatus() {
  try {
    if (!('LanguageModel' in self)) return 'unsupported';
    return await self.LanguageModel.availability(lang); // available | downloadable | downloading | unavailable
  } catch {
    return 'unsupported';
  }
}

// Must run inside a user gesture (a click). Downloads the model on first use.
export async function wakeDevice(onProgress) {
  await detector.initializeDeviceModel(onProgress);
  await Promise.allSettled([localModel.initializeDeviceModel(), cloudModel.initializeDeviceModel()]);
}

export const fromDevice = (res) => String(res.response.inferenceSource || '').toLowerCase().includes('device');
