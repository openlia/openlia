import type { FirebaseClientConfig } from "../shared/api";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  type Auth,
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut,
} from "firebase/auth";

let currentConfig: FirebaseClientConfig | null = null;
let currentAuth: Auth | null = null;

export function getFirebaseAuth(config: FirebaseClientConfig): Auth {
  if (
    currentAuth &&
    currentConfig &&
    currentConfig.apiKey === config.apiKey &&
    currentConfig.projectId === config.projectId
  ) {
    return currentAuth;
  }

  const app =
    getApps().length > 0
      ? getApp()
      : initializeApp({
          apiKey: config.apiKey,
          authDomain: config.authDomain,
          projectId: config.projectId,
          ...(config.appId ? { appId: config.appId } : {}),
        });

  currentConfig = config;
  currentAuth = getAuth(app);
  return currentAuth;
}

export async function signInWithGoogle(
  config: FirebaseClientConfig,
): Promise<string> {
  const auth = getFirebaseAuth(config);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user.getIdToken();
}

export async function signOutFirebase(
  config?: FirebaseClientConfig,
): Promise<void> {
  try {
    if (config) {
      const auth = getFirebaseAuth(config);
      await signOut(auth);
    } else if (currentAuth) {
      await signOut(currentAuth);
    }
  } catch {
    // Ignore sign-out cleanup errors
  }
}
