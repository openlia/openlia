export function buildContentSecurityPolicy(nonce: string): string {
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.googleusercontent.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseio.com; frame-src 'self' https://*.firebaseapp.com https://accounts.google.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}
