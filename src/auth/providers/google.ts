import type { OAuthProviderConfig } from '../oauth-provider.js';
import { promptGoogleScopes, resolveGoogleShortScopes } from './google-scopes.js';

export const googleOAuthProvider: OAuthProviderConfig = {
  id: 'google',
  displayName: 'Google Workspace',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  defaultScopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  callbackPath: '/callback',
  usePkce: true,
  serverNames: ['google-workspace'],
  tokenEnvVar: 'GOOGLE_ACCESS_TOKEN',
  refreshTokenEnvVar: 'GOOGLE_REFRESH_TOKEN',
  clientIdEnvVar: 'GOOGLE_CLIENT_ID',
  clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
  credentialsFilename: 'google-credentials.json',
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  scopePicker: promptGoogleScopes,
  resolveShortScopes: resolveGoogleShortScopes,
};
