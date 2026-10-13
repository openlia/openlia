import type { FirebaseClientConfig } from "../shared/api";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  type Auth,
  type User,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";

export interface FirebaseAccount {
  displayName: string | null;
  email: string | null;
}

let currentConfig: FirebaseClientConfig | null = null;
let currentAuth: Auth | null = null;

function accountFromUser(user: User | null): FirebaseAccount | null {
  if (!user) return null;
  return {
    displayName: user.displayName,
    email: user.email,
  };
}

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
): Promise<{ account: FirebaseAccount; idToken: string }> {
  const auth = getFirebaseAuth(config);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return {
    account: accountFromUser(result.user) ?? { displayName: null, email: null },
    idToken: await result.user.getIdToken(),
  };
}

export function subscribeToFirebaseAuth(
  config: FirebaseClientConfig,
  onAccountChange: (account: FirebaseAccount | null) => void,
): () => void {
  return onAuthStateChanged(getFirebaseAuth(config), (user) => {
    onAccountChange(accountFromUser(user));
  });
}

export async function signOutFirebase(
  config?: FirebaseClientConfig,
): Promise<void> {
  if (config) {
    const auth = getFirebaseAuth(config);
    await signOut(auth);
  } else if (currentAuth) {
    await signOut(currentAuth);
  }
}
